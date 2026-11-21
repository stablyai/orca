import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: homedirMock
}))
import {
  syncSystemConfigIntoLegacySharedCodexHome,
  syncSystemConfigIntoManagedCodexHome
} from './codex-config-mirror'
import { CODEX_DAEMON_OVERRIDE_MARKER } from '../shared-server/codex-daemon-socket-path-guard'

let root: string
let runtimeHomePath: string
let systemHomePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-mirror-guard-'))
  // Long enough that the daemon socket exceeds sun_path on every OS, so the guard applies.
  runtimeHomePath = join(root, 'u'.repeat(90), 'codex-runtime-home', 'home')
  systemHomePath = join(root, 'home', '.codex')
  mkdirSync(runtimeHomePath, { recursive: true })
  mkdirSync(systemHomePath, { recursive: true })
  homedirMock.mockReturnValue(join(root, 'home'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const SYSTEM_CONFIGS = {
  plain: 'model = "gpt-5"\n\n[projects."/work/one"]\ntrust_level = "trusted"\n',
  'own [features] table':
    'model = "gpt-5"\n\n[features]\nweb_search = true\n\n[projects."/work/one"]\ntrust_level = "trusted"\n',
  CRLF: 'model = "gpt-5"\r\n\r\n[projects."/work/one"]\r\ntrust_level = "trusted"\r\n'
}

it.each(Object.entries(SYSTEM_CONFIGS))(
  'leaves the runtime config unchanged when tables were appended after the daemon guard (%s)',
  (_name, systemConfig) => {
    const hooksJson = join(systemHomePath, 'hooks.json')
    // A user hook approval in ~/.codex is mirrored into the managed home too.
    writeFileSync(
      join(systemHomePath, 'config.toml'),
      `${systemConfig}\n[hooks.state."${hooksJson.replaceAll('\\', '\\\\')}:stop:0:0"]\nenabled = true\n`
    )
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    const sync = (): void => {
      syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })
    }
    sync()
    sync()
    expect(readFileSync(runtimeConfigPath, 'utf-8')).toContain(CODEX_DAEMON_OVERRIDE_MARKER)
    // A project trust grant and a hook approval each append their table at the end.
    appendFileSync(
      runtimeConfigPath,
      '\n[projects."/work/two"]\ntrust_level = "trusted"\n\n[hooks.state."/h/hooks.json:stop:0:0"]\nenabled = true\n'
    )
    const settled = readFileSync(runtimeConfigPath, 'utf-8')

    sync()

    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe(settled)
    expect(readFileSync(join(systemHomePath, 'config.toml'), 'utf-8')).not.toContain(
      CODEX_DAEMON_OVERRIDE_MARKER
    )
  }
)

it('keeps a BOM-led inline features table a single valid definition', () => {
  writeFileSync(
    join(systemHomePath, 'config.toml'),
    '\uFEFFfeatures = { daemon_auto_start = false }\nmodel = "gpt-5"\n'
  )
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

  syncSystemConfigIntoManagedCodexHome({ runtimeHomePath, systemHomePath })

  expect(parseToml(readFileSync(runtimeConfigPath, 'utf-8'))).toMatchObject({
    features: { daemon_auto_start: false },
    model: 'gpt-5'
  })
})

it('lets the legacy shared-home refresh and the managed mirror agree on one layout', () => {
  writeFileSync(join(systemHomePath, 'config.toml'), SYSTEM_CONFIGS.plain)
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  const homes = { runtimeHomePath, systemHomePath }
  syncSystemConfigIntoManagedCodexHome(homes)
  syncSystemConfigIntoManagedCodexHome(homes)
  appendFileSync(runtimeConfigPath, '\n[projects."/work/two"]\ntrust_level = "trusted"\n')
  const settled = readFileSync(runtimeConfigPath, 'utf-8')

  syncSystemConfigIntoLegacySharedCodexHome(homes)

  expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe(settled)
})
