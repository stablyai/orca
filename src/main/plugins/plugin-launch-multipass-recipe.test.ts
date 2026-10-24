import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  buildEphemeralVmRecipeCleanupCommand,
  buildEphemeralVmRecipeCleanupPayload,
  runEphemeralVmRecipeCleanup,
  runEphemeralVmRecipeResume,
  runEphemeralVmRecipeStart,
  runEphemeralVmRecipeSuspend
} from '../../shared/ephemeral-vm-recipe-runner'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'

const recipe = parsePluginVmRecipeArtifact(
  readFileSync(
    join(
      process.cwd(),
      'resources/plugins/launch/stablyai.orca-multipass-recipes/recipes/ubuntu-lts.json'
    ),
    'utf8'
  )
)

// Why: a recording stand-in lets the lifecycle run without Multipass installed.
const FAKE_MULTIPASS = `#!/bin/sh
printf '%s\\n' "$*" >> "$MULTIPASS_LOG"
case "$1" in
  launch) cat > "$MULTIPASS_LOG.cloud-init" ;;
  info) [ -n "\${FAKE_MULTIPASS_NO_IP:-}" ] && ip= || ip=192.0.2.10
    printf 'Name,State,Zone,Zone available,Ipv4,Release\\n%s,Running,zone1,true,%s,Ubuntu 24.04 LTS\\n' "$2" "$ip" ;;
esac
`

const tmpRoots: string[] = []

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture(): { repoPath: string; env: NodeJS.ProcessEnv; log: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-multipass-recipe-'))
  tmpRoots.push(root)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'multipass'), FAKE_MULTIPASS)
  chmodSync(join(bin, 'multipass'), 0o755)
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath)
  const git = (...args: string[]): void => {
    const result = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
  }
  git('init', '-q')
  git(
    '-c',
    'user.name=Orca',
    '-c',
    'user.email=orca@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
  const log = join(root, 'multipass.log')
  const state = join(root, 'state')
  return {
    repoPath,
    log,
    state,
    env: {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      MULTIPASS_LOG: log,
      XDG_STATE_HOME: state
    }
  }
}

function readLog(log: string): string[] {
  return readFileSync(log, 'utf8').trim().split('\n')
}

describe.skipIf(process.platform === 'win32')('Multipass launch recipe', () => {
  it('names the VM from ORCA_VM_INSTANCE_ID and prints an SSH connection', async () => {
    const fixture = makeFixture()

    const start = await runEphemeralVmRecipeStart({
      recipe,
      repoPath: fixture.repoPath,
      env: fixture.env
    })

    expect(start.ok, start.ok ? '' : `${start.error}\n${start.stderr}`).toBe(true)
    if (!start.ok) {
      return
    }
    const name = start.context.instanceId
    const identityFile = join(fixture.state, 'orca', 'multipass', 'id_ed25519')
    expect(getEphemeralVmRecipeResultConnection(start.result)).toEqual({
      type: 'ssh',
      projectRoot: '/home/ubuntu/repo',
      target: {
        label: name,
        host: '192.0.2.10',
        port: 22,
        username: 'ubuntu',
        identityFile,
        identitiesOnly: true
      }
    })
    expect(readLog(fixture.log)).toEqual([
      `launch 24.04 --name ${name} --cpus 4 --memory 8G --disk 40G --cloud-init -`,
      expect.stringMatching(new RegExp(`^transfer \\S+ ${name}:/home/ubuntu/repo\\.bundle$`)),
      `exec ${name} -- git clone -q /home/ubuntu/repo.bundle /home/ubuntu/repo`,
      `info ${name} --format csv`
    ])
    expect(readFileSync(`${fixture.log}.cloud-init`, 'utf8')).toContain(
      readFileSync(`${identityFile}.pub`, 'utf8').trim()
    )
  })

  it('targets the created VM for suspend, resume, and destroy', async () => {
    const fixture = makeFixture()
    const start = await runEphemeralVmRecipeStart({
      recipe,
      repoPath: fixture.repoPath,
      env: fixture.env
    })
    expect(start.ok).toBe(true)
    if (!start.ok) {
      return
    }
    const lifecycle = {
      recipe,
      repoPath: fixture.repoPath,
      context: start.context,
      recipeResult: start.result,
      env: fixture.env
    }

    expect(await runEphemeralVmRecipeSuspend(lifecycle)).toMatchObject({ ok: true })
    const resume = await runEphemeralVmRecipeResume(lifecycle)
    expect(resume).toMatchObject({ ok: true, skipped: false, result: start.result })
    expect(await runEphemeralVmRecipeCleanup(lifecycle)).toMatchObject({ ok: true })

    const name = start.context.instanceId
    expect(readLog(fixture.log).slice(-4)).toEqual([
      `suspend ${name}`,
      `start ${name}`,
      `info ${name} --format csv`,
      `delete --purge ${name}`
    ])
  })

  it('destroys the VM from the copied cleanup command without Orca env', async () => {
    const fixture = makeFixture()
    const start = await runEphemeralVmRecipeStart({
      recipe,
      repoPath: fixture.repoPath,
      env: fixture.env
    })
    expect(start.ok).toBe(true)
    if (!start.ok || !recipe.destroy) {
      return
    }
    const command = buildEphemeralVmRecipeCleanupCommand({
      destroyCommand: recipe.destroy,
      payload: buildEphemeralVmRecipeCleanupPayload({
        recipe,
        context: start.context,
        recipeResult: start.result
      })
    })

    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: fixture.repoPath,
      encoding: 'utf8',
      env: { PATH: fixture.env.PATH, MULTIPASS_LOG: fixture.log }
    })

    expect(result.status, result.stderr).toBe(0)
    expect(readLog(fixture.log).at(-1)).toBe(`delete --purge ${start.context.instanceId}`)
  })

  it('deletes the VM when create fails after launch', async () => {
    const fixture = makeFixture()

    const start = await runEphemeralVmRecipeStart({
      recipe,
      repoPath: fixture.repoPath,
      env: { ...fixture.env, FAKE_MULTIPASS_NO_IP: '1' }
    })

    expect(start).toMatchObject({ ok: false, stdout: '' })
    expect(readLog(fixture.log).at(-1)).toBe(`delete --purge ${start.context.instanceId}`)
  })
})
