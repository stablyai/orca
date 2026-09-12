import assert from 'node:assert/strict'
import { runWslProcess } from '../../src/main/wsl/wsl-runner'
import {
  materializeWslWorktreePaths,
  inspectWslWorktreeSharedLinks
} from '../../src/main/ipc/wsl-worktree-path-materialization'

async function main(): Promise<void> {
  assert.equal(process.platform, 'win32')
  const distro = process.argv[2]
  const created = await runWslProcess({
    distro,
    loginPath: 'none',
    program: 'mktemp',
    args: ['-d', '/tmp/orca-cow-wrapper.XXXXXXXX']
  })
  assert.equal(created.code, 0)
  const root = created.stdout.trim()
  assert.match(root, /^\/tmp\/orca-cow-wrapper\.[A-Za-z0-9]+$/)
  console.log(JSON.stringify({ guestFixture: root }))
  const setup = `const f=require('node:fs'),p=require('node:path'),c=require('node:child_process');
const r=process.argv[1],s=p.join(r,'source'),t=p.join(r,'target');f.mkdirSync(s);f.mkdirSync(t);
c.execFileSync('git',['init','-q',s]);c.execFileSync('git',['init','-q',t]);
f.writeFileSync(p.join(s,'.gitignore'),'.env\\ndeps/\\ncache/\\n');f.writeFileSync(p.join(s,'.worktreeinclude'),'.env\\ncache\\n');
f.writeFileSync(p.join(s,'orca.yaml'),'worktree:\\n  sharedDirectories:\\n    - deps\\n');
f.writeFileSync(p.join(s,'.env'),'original');f.mkdirSync(p.join(s,'deps'));f.writeFileSync(p.join(s,'deps','value'),'shared');
f.mkdirSync(p.join(s,'cache'));f.writeFileSync(p.join(s,'cache','value'),'original');f.symlinkSync('value',p.join(s,'cache','alias'));
console.log(JSON.stringify({node:process.execPath,platform:process.platform}));`
  const initialized = await runWslProcess({
    distro,
    loginPath: 'preferred',
    program: 'node',
    args: ['-e', setup, root]
  })
  assert.equal(initialized.code, 0, initialized.stderr)
  assert.equal(initialized.environmentResolved, true)
  console.log(initialized.stdout.trim())
  const source = `${root}/source`,
    target = `${root}/target`
  assert.equal(await materializeWslWorktreePaths(distro, source, target, []), undefined)
  assert.deepEqual(await inspectWslWorktreeSharedLinks(distro, source, target, []), ['deps'])
  const verify = `const f=require('node:fs'),p=require('node:path'),a=require('node:assert/strict');const r=process.argv[1],s=p.join(r,'source'),t=p.join(r,'target');
f.writeFileSync(p.join(t,'.env'),'private');a.equal(f.readFileSync(p.join(s,'.env'),'utf8'),'original');f.writeFileSync(p.join(t,'cache','alias'),'private');a.equal(f.readFileSync(p.join(s,'cache','value'),'utf8'),'original');f.writeFileSync(p.join(t,'deps','value'),'shared edit');a.equal(f.readFileSync(p.join(s,'deps','value'),'utf8'),'shared edit');`
  const verified = await runWslProcess({
    distro,
    loginPath: 'preferred',
    program: 'node',
    args: ['-e', verify, root]
  })
  assert.equal(verified.code, 0, verified.stderr)
  assert.deepEqual(await inspectWslWorktreeSharedLinks(distro, source, target, [], true), ['deps'])
  assert.deepEqual(await inspectWslWorktreeSharedLinks(distro, source, target, []), [])
  const cleaned = await runWslProcess({
    distro,
    loginPath: 'none',
    program: '/bin/rm',
    args: ['-rf', '--', root]
  })
  assert.equal(cleaned.code, 0)
  console.log(
    JSON.stringify({
      platform: process.platform,
      distro,
      productionWrapper: true,
      loginPathResolved: true,
      materialized: true,
      removedLinks: true,
      passed: true
    })
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
