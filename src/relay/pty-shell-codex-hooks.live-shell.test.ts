import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveFishBinary } from '../shared/fish-binary-requirement'
import { getRelayShellLaunchConfig } from './pty-shell-launch'

type TestShell = { name: 'bash' | 'zsh' | 'fish'; path: string }
type HookCoordinate = 'ORCA_AGENT_HOOK_PORT' | 'ORCA_AGENT_HOOK_TOKEN' | 'ORCA_PANE_KEY'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

const roots: string[] = []

function discoverShells(): TestShell[] {
  const shells: TestShell[] = []
  for (const path of ['/bin/bash', '/bin/zsh']) {
    if (existsSync(path)) {
      shells.push({ name: basename(path) as 'bash' | 'zsh', path })
    }
  }
  const fish = resolveFishBinary(4)
  if (fish.available) {
    const resolved = fish.path.includes('/')
      ? fish.path
      : spawnSync('sh', ['-c', `command -v ${fish.path}`], { encoding: 'utf8' }).stdout.trim()
    if (resolved) {
      shells.push({ name: 'fish', path: resolved })
    }
  }
  return shells
}

function writeUserConfig(shell: TestShell, root: string, bin: string, opaque: boolean): void {
  const pathLine =
    shell.name === 'fish'
      ? `set -gx PATH ${JSON.stringify(bin)} /usr/bin /bin /usr/sbin /sbin`
      : `export PATH=${JSON.stringify(`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`)}`
  const customCommand =
    shell.name === 'fish'
      ? 'function codex; command codex --alias-flag $argv; end'
      : "alias codex='codex --alias-flag'"
  const content = [pathLine, ...(opaque ? [customCommand] : [])].join('\n')
  if (shell.name === 'fish') {
    const configDir = join(root, '.config', 'fish')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.fish'), content)
  } else {
    writeFileSync(join(root, shell.name === 'zsh' ? '.zshrc' : '.bash_profile'), content)
  }
}

function runRelayCodex(
  shell: TestShell,
  options: {
    version?: string
    coordinates?: Partial<Record<HookCoordinate, string>>
    args?: string
    opaque?: boolean
  } = {}
): { argv: string[] } {
  const root = mkdtempSync(join(tmpdir(), `orca-relay-codex-${shell.name}-`))
  roots.push(root)
  const bin = join(root, 'bin')
  const output = join(root, 'codex-output')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh
if [ "\${1-}" = --version ]; then
  if [ "\${ORCA_CODEX_TEST_VERSION:-}" = hang ]; then while :; do :; done; fi
  printf 'codex-cli %s\\n' "\${ORCA_CODEX_TEST_VERSION:-0.149.0}"
  exit 0
fi
for arg do printf '%s\\037' "$arg"; done > "$ORCA_CODEX_TEST_OUTPUT"
`
  )
  chmodSync(join(bin, 'codex'), 0o755)
  writeUserConfig(shell, root, bin, options.opaque === true)

  const env: Record<string, string> = {
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: 'xterm-256color',
    XDG_CONFIG_HOME: join(root, '.config'),
    ORCA_CODEX_TEST_OUTPUT: output,
    ORCA_CODEX_TEST_VERSION: options.version ?? '0.149.0',
    ...options.coordinates
  }
  const config = getRelayShellLaunchConfig(shell.path, env, 'linux', {
    emitReadyMarker: true,
    emitStartupIdentity: true,
    codexHooksEnabled: true
  })
  const childEnv = { ...env, ...config.env }
  const result = spawnSync(shell.path, [...config.args, '-i'], {
    encoding: 'utf8',
    env: childEnv,
    input: `codex${options.args ? ` ${options.args}` : ''}\nexit\n`,
    timeout: 15_000
  })

  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
  expect(existsSync(output), `${result.stderr}\n${result.stdout}`).toBe(true)
  return { argv: readFileSync(output, 'utf8').split('\x1f').slice(0, -1) }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const SHELLS = discoverShells()

describe.skipIf(process.platform === 'win32')('relay Codex hook launch in real shells', () => {
  it('finds at least one supported shell', () => {
    expect(SHELLS.length).toBeGreaterThan(0)
  })

  describe.each(SHELLS)('$name', (shell) => {
    const coordinates = {
      ORCA_AGENT_HOOK_PORT: '43117',
      ORCA_AGENT_HOOK_TOKEN: 'token-1',
      ORCA_PANE_KEY: PANE_KEY
    }

    it.each([
      ['0.113.0', []],
      ['0.114.0', ['--enable', 'codex_hooks']],
      ['0.128.0', ['--enable', 'codex_hooks']],
      ['0.129.0', ['--enable', 'hooks']],
      ['1.0.0', ['--enable', 'hooks']],
      ['1.beta.0', []],
      ['10.x.y', []]
    ])('selects the supported feature for Codex %s', (version, expected) => {
      expect(runRelayCodex(shell, { version, coordinates }).argv).toEqual(expected)
    })

    it('requires final hook server coordinates', () => {
      expect(runRelayCodex(shell, { coordinates: { ORCA_AGENT_HOOK_PORT: '43117' } }).argv).toEqual(
        []
      )
    })

    it('requires final pane identity', () => {
      expect(
        runRelayCodex(shell, {
          coordinates: {
            ORCA_AGENT_HOOK_PORT: '43117',
            ORCA_AGENT_HOOK_TOKEN: 'token-1'
          }
        }).argv
      ).toEqual([])
    })

    it('preserves an explicit launch override', () => {
      expect(runRelayCodex(shell, { coordinates, args: '--disable hooks' }).argv).toEqual([
        '--disable',
        'hooks'
      ])
    })

    it('leaves a user alias or function opaque', () => {
      expect(runRelayCodex(shell, { coordinates, opaque: true }).argv).toEqual(['--alias-flag'])
    })

    it('fails open when version discovery hangs', () => {
      const startedAt = Date.now()
      expect(runRelayCodex(shell, { version: 'hang', coordinates }).argv).toEqual([])
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    })
  })
})
