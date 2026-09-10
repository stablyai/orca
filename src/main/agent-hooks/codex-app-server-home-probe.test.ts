import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexProbeEnvironment,
  probeCodexHomeViaAppServer
} from './codex-app-server-home-probe'

// The probe speaks to a real child over pipes; `/bin/sh` is the shell it uses
// on every host that reaches this code (Windows remotes never install hooks).
const onPosix = process.platform === 'win32' ? it.skip : it

const temporaryRoots: string[] = []

async function withFakeCodex(script: string): Promise<NodeJS.ProcessEnv> {
  const binDir = await mkdtemp(join(tmpdir(), 'orca-codex-probe-'))
  temporaryRoots.push(binDir)
  const codexPath = join(binDir, 'codex')
  await writeFile(codexPath, script, 'utf8')
  await chmod(codexPath, 0o755)
  return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
}

function probe(env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<string | null> {
  return probeCodexHomeViaAppServer({
    loginShell: '/bin/sh',
    loginShellFlag: '-c',
    env,
    timeoutMs
  })
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe('probeCodexHomeViaAppServer', () => {
  onPosix('reads the codexHome the app-server reports', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
read -r _line
printf '%s\\n' '{"id":1,"result":{"codexHome":"/home/dev/.codex-openai","platformFamily":"unix"}}'
# Hold the pipe open the way a real app-server does.
sleep 5
`
    )

    await expect(probe(env)).resolves.toBe('/home/dev/.codex-openai')
  })

  onPosix('ignores a login-shell banner printed ahead of the reply', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
echo 'Welcome to Ubuntu 24.04 LTS'
echo 'Last login: Tue'
read -r _line
printf '%s\\n' '{"id":1,"result":{"codexHome":"/home/dev/.codex-openai"}}'
sleep 5
`
    )

    await expect(probe(env)).resolves.toBe('/home/dev/.codex-openai')
  })

  onPosix('skips notifications that arrive before the initialize result', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
read -r _line
printf '%s\\n' '{"method":"remoteControl/status/changed","params":{"status":"disabled"}}'
printf '%s\\n' '{"id":1,"result":{"codexHome":"/opt/codex-home"}}'
sleep 5
`
    )

    await expect(probe(env)).resolves.toBe('/opt/codex-home')
  })

  onPosix('answers null when the CLI exits without a reply', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
echo 'Error: CODEX_HOME points to a path that does not exist' >&2
exit 1
`
    )

    await expect(probe(env)).resolves.toBeNull()
  })

  onPosix('answers null when the CLI never replies, without hanging', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
sleep 30
`
    )

    await expect(probe(env, 400)).resolves.toBeNull()
  })

  onPosix('answers null when codex is not on PATH at all', async () => {
    await expect(probe({ ...process.env, PATH: '/nonexistent-orca-probe-dir' })).resolves.toBeNull()
  })

  onPosix('answers null once the install is aborted', async () => {
    const env = await withFakeCodex(
      `#!/bin/sh
sleep 30
`
    )
    const controller = new AbortController()
    const startedAt = Date.now()
    // A deadline far past this assertion, so only the abort can settle the probe.
    const pending = probeCodexHomeViaAppServer({
      loginShell: '/bin/sh',
      loginShellFlag: '-c',
      env,
      signal: controller.signal,
      timeoutMs: 60_000
    })
    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })
})

describe('buildCodexProbeEnvironment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('drops the CODEX_HOME Orca injected for its own managed accounts', () => {
    // Orca exports these for its managed Codex accounts. Reading one back would
    // report Orca's own answer as if it were the host user's configuration.
    vi.stubEnv('CODEX_HOME', '/orca/codex-accounts/abc/home')
    vi.stubEnv('ORCA_CODEX_HOME', '/orca/codex-accounts/abc/home')

    const env = buildCodexProbeEnvironment('/home/dev')

    expect(env.CODEX_HOME).toBeUndefined()
    expect(env.ORCA_CODEX_HOME).toBeUndefined()
  })

  it('pins HOME to the home the installer resolved', () => {
    expect(buildCodexProbeEnvironment('/home/dev').HOME).toBe('/home/dev')
  })

  onPosix('asks Codex under the installer s home, not Orca s injected one', async () => {
    vi.stubEnv('CODEX_HOME', '/orca/codex-accounts/abc/home')
    const fake = await withFakeCodex(
      `#!/bin/sh
read -r _line
home="\${CODEX_HOME:-$HOME/.codex}"
printf '{"id":1,"result":{"codexHome":"%s"}}\\n' "$home"
sleep 5
`
    )

    await expect(
      probeCodexHomeViaAppServer({
        loginShell: '/bin/sh',
        loginShellFlag: '-c',
        env: { ...buildCodexProbeEnvironment('/home/dev'), PATH: fake.PATH },
        timeoutMs: 10_000
      })
    ).resolves.toBe('/home/dev/.codex')
  })
})
