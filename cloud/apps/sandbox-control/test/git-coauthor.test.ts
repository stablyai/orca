// GIT-COAUTHOR: a commit that falls back to the workspace identity while a known member drove it carries a
// Co-authored-by trailer for them (their GitHub noreply address), so attribution survives. No token involved.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { coauthorTrailer } from '../src/member-git'

const GIT_AS = fileURLToPath(new URL('../image/vm/orca-git-as', import.meta.url).href)
const MEMBERS = fileURLToPath(new URL('../image/vm/orca-sandbox-members', import.meta.url).href)
const CO = 'Ada Lovelace <11+ada-gh@users.noreply.github.com>'
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

/** A repo, and a stand-in `sudo` that hands orca-git-as a one-shot copy of `config` (as orca-git-identity does). */
function scratch(config: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'orca-git-coauthor-'))
  dirs.push(root)
  mkdirSync(join(root, 'bin'))
  mkdirSync(join(root, 'repo'))
  const source = join(root, 'member.gitconfig')
  writeFileSync(source, '')
  for (const [key, value] of Object.entries(config)) {
    execFileSync('git', ['config', '-f', source, key, value])
  }
  writeFileSync(join(root, 'bin/sudo'), `#!/usr/bin/env bash\nout="$(mktemp)"; cp "${source}" "$out"; echo "$out"\n`)
  chmodSync(join(root, 'bin/sudo'), 0o755)
  const env = {
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1'
  }
  // The workspace identity, as orca-sandbox-start sets it.
  writeFileSync(join(root, '.gitconfig'), '[user]\n\tname = Orca\n\temail = noreply@orca.dev\n')
  execFileSync('git', ['init', '-q', join(root, 'repo')], { env })
  const gitAs = (args: string[]) => spawnSync('bash', [GIT_AS, ...args], { cwd: join(root, 'repo'), env, encoding: 'utf8' })
  const last = () => execFileSync('git', ['-C', join(root, 'repo'), 'log', '-1', '--format=%an <%ae>%n%B'], { env, encoding: 'utf8' }).trim()
  return { gitAs, last, root }
}

describe('Co-authored-by for a member whose GitHub identity cannot be used', () => {
  it('a commit falls back to the workspace identity with the member as co-author', () => {
    const t = scratch({ 'orca.coauthor': CO })
    const run = t.gitAs(['-c', 'core.quotePath=false', 'commit', '-q', '--allow-empty', '-m', 'feat: x'])
    expect(run.status).toBe(0)
    expect(run.stderr).toContain('orca-git-as: no teammate identity')
    expect(t.last()).toBe(`Orca <noreply@orca.dev>\nfeat: x\n\nCo-authored-by: ${CO}`)
  })

  it('other commands run untouched; a value that is the commit message is not mistaken for the subcommand', () => {
    const t = scratch({ 'orca.coauthor': CO })
    expect(t.gitAs(['commit', '-q', '--allow-empty', '-m', 'commit']).status).toBe(0)
    expect(t.last()).toBe(`Orca <noreply@orca.dev>\ncommit\n\nCo-authored-by: ${CO}`)
    expect(t.gitAs(['tag', 'v1']).status).toBe(0)
    expect(t.gitAs(['tag', '-l']).stdout.trim()).toBe('v1')
  })

  it('a member with a usable identity commits as themselves, no trailer', () => {
    const t = scratch({ 'user.name': 'Ada', 'user.email': '11+ada-gh@users.noreply.github.com' })
    expect(t.gitAs(['commit', '-q', '--allow-empty', '-m', 'feat: y']).status).toBe(0)
    expect(t.last()).toBe('Ada <11+ada-gh@users.noreply.github.com>\nfeat: y')
  })

  it('--as that member is refused rather than silently acting as the workspace', () => {
    const t = scratch({ 'orca.coauthor': CO })
    const run = t.gitAs(['--as', 'ada', 'commit', '-q', '--allow-empty', '-m', 'z'])
    expect(run.status).toBe(4)
    expect(run.stderr).toContain("can't be used right now")
    expect(existsSync(join(t.root, 'repo/.git/refs/heads/main')) || existsSync(join(t.root, 'repo/.git/refs/heads/master'))).toBe(false)
  })
})

describe('coauthorTrailer', () => {
  it('builds the GitHub noreply line, falling back to the login for an odd display name', () => {
    expect(coauthorTrailer('ada-gh', 11, 'Ada Lovelace')).toBe(CO)
    expect(coauthorTrailer('ada-gh', 11, null)).toBe('ada-gh <11+ada-gh@users.noreply.github.com>')
    expect(coauthorTrailer('ada-gh', 11, 'Evil <x@y>\nCo-authored-by: z')).toBe('ada-gh <11+ada-gh@users.noreply.github.com>')
    expect(coauthorTrailer('bad login', 11, 'x')).toBeNull()
    expect(coauthorTrailer('ada', 0, 'x')).toBeNull()
  })
})

describe('orca-sandbox-members devices map', () => {
  // The script's own jq program (DEVICES_JQ), run on its two inputs: members, then co-authors.
  const program = /^DEVICES_JQ='(.*)'$/m.exec(readFileSync(MEMBERS, 'utf8'))![1]!
  const devices = (members: unknown, coauthors: unknown) =>
    JSON.parse(execFileSync('jq', ['-c', '-s', program], { input: `${JSON.stringify(members)}\n${JSON.stringify(coauthors)}`, encoding: 'utf8' }))

  it('maps each device to its member, across both lists', () => {
    expect(devices([{ userId: 'alice', deviceIds: ['d1'] }], [{ userId: 'bob', deviceIds: ['d2', 'bad id'] }])).toEqual({ d1: 'alice', d2: 'bob' })
  })

  it('a device id claimed by two people maps to nobody (members, or member and co-author)', () => {
    expect(devices([{ userId: 'alice', deviceIds: ['d1', 'd2'] }, { userId: 'bob', deviceIds: ['d1'] }], [])).toEqual({ d2: 'alice' })
    expect(devices([{ userId: 'alice', deviceIds: ['d1'] }], [{ userId: 'bob', deviceIds: ['d1'] }])).toEqual({})
    // The same person listing a device twice is still theirs.
    expect(devices([{ userId: 'alice', deviceIds: ['d1', 'd1'] }], [])).toEqual({ d1: 'alice' })
  })
})

