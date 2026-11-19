import type * as Lookup from '../../trust/hooks/codex-hook-hash-lookup'
import type * as Mirror from '../../configuration/settings/codex-config-mirror'
import type * as Legacy from '../reconciliation/codex-hook-legacy-cleanup'
import type * as Inputs from './codex-launch-preparation-inputs'
import type { CodexHookAnswer } from '../../trust/hooks/codex-hook-trust-derivation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type * as Fs from 'node:fs'
import type * as Os from 'node:os'
import { basename, join } from 'node:path'
import { hookTrustHeader, setupCodexHookHomes } from './hook-service-test-harness'
import { upsertHookTrustContent } from '../../trust/toml/config-toml-hook-trust-edit'

const { getPathMock, homedirMock, prepareFactoryHooks, controls } = vi.hoisted(() => {
  const controls: {
    aroundMirror: null | (() => () => void)
    afterCleanup: null | (() => void)
    hideLegacy: boolean
    failLegacyDelete: boolean
    afterSnapshot: null | (() => void)
    answer: CodexHookAnswer | null
  } = {
    aroundMirror: null,
    afterCleanup: null,
    hideLegacy: false,
    failLegacyDelete: false,
    afterSnapshot: null,
    answer: null
  }
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    prepareFactoryHooks: vi.fn(),
    controls
  }
})

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('../../trust/project-trust/codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (
    await import('../../trust/project-trust/codex-project-trust-worker.test-fixture')
  ).codexProjectTrustTestWorker.factory
}))
vi.mock('./hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: prepareFactoryHooks }
}))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: homedirMock
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    existsSync: (filePath: Fs.PathLike) => {
      if (controls.hideLegacy && String(filePath).endsWith('orca-agent-status.config.toml')) {
        controls.hideLegacy = false
        return false
      }
      return actual.existsSync(filePath)
    },
    unlinkSync: (filePath: Fs.PathLike) => {
      if (controls.failLegacyDelete && String(filePath).endsWith('orca-agent-status.config.toml')) {
        controls.failLegacyDelete = false
        throw Object.assign(new Error('Legacy profile is temporarily locked'), { code: 'EACCES' })
      }
      return actual.unlinkSync(filePath)
    }
  }
})
vi.mock('../../trust/hooks/codex-hook-hash-lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof Lookup>()),
  resolveCodexHookAnswerForLaunch: async () => controls.answer,
  readKnownCodexHookAnswer: () => controls.answer
}))
vi.mock('./codex-launch-preparation-inputs', async (importOriginal) => {
  const actual = await importOriginal<typeof Inputs>()
  return {
    ...actual,
    readCodexLaunchPreparationInputs: async (
      ...args: Parameters<typeof actual.readCodexLaunchPreparationInputs>
    ) => {
      const result = await actual.readCodexLaunchPreparationInputs(...args)
      const callback = controls.afterSnapshot
      controls.afterSnapshot = null
      callback?.()
      return result
    }
  }
})
vi.mock('../../configuration/settings/codex-config-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof Mirror>()
  return {
    ...actual,
    syncSystemConfigIntoManagedCodexHome: (
      ...args: Parameters<typeof actual.syncSystemConfigIntoManagedCodexHome>
    ) => {
      const callback = controls.aroundMirror
      controls.aroundMirror = null
      const restore = callback?.()
      try {
        return actual.syncSystemConfigIntoManagedCodexHome(...args)
      } finally {
        restore?.()
      }
    }
  }
})
vi.mock('../reconciliation/codex-hook-legacy-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof Legacy>()
  return {
    ...actual,
    cleanupLegacyManagedHookRepresentations: async () => {
      const complete = await actual.cleanupLegacyManagedHookRepresentations()
      const callback = controls.afterCleanup
      controls.afterCleanup = null
      callback?.()
      return complete
    }
  }
})

import { CodexHookService } from './codex-hook-service-implementation'
import { getManagedScriptPath } from '../definitions/codex-hook-definition'
import { createCodexRuntimeHomeLaunchPreparation } from '../../configuration/homes/codex-runtime-home-launch-preparation'
import { syncSystemConfigIntoManagedCodexHome } from '../../configuration/settings/codex-config-mirror'
import { codexProjectTrustTestWorker } from '../../trust/project-trust/codex-project-trust-worker.test-fixture'

const homes = setupCodexHookHomes(homedirMock, getPathMock)
beforeEach(() => {
  controls.aroundMirror = null
  controls.afterCleanup = null
  controls.hideLegacy = false
  controls.failLegacyDelete = false
  controls.afterSnapshot = null
  controls.answer = {
    kind: 'hashes',
    codexVersion: 'codex-cli 0.157.0',
    hashes: { stop: 'sha256:prepared-stop' }
  }
})

function seed(model = 'B'): {
  service: CodexHookService
  home: string
  source: string
  runtime: string
} {
  const systemHome = join(homes.tmpHome, '.codex')
  mkdirSync(systemHome, { recursive: true })
  const source = join(systemHome, 'config.toml')
  writeFileSync(source, `model = "${model}"\n`)
  const home = join(homes.userDataDir, 'launch-home')
  return { service: new CodexHookService(), home, source, runtime: join(home, 'config.toml') }
}

async function settle(service: CodexHookService, home: string): Promise<void> {
  for (let index = 0; index < 3; index++) {
    expect((await service.installForLaunchPrep(home, true, () => true)).state).toBe('installed')
  }
}

describe('completed Codex launch preparation', () => {
  it('preserves the recovery backup through the launch factory when inputs are unchanged', async () => {
    const { service, home, runtime } = seed()
    prepareFactoryHooks.mockImplementation(service.prepareRuntimeHomeForLaunch.bind(service))
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          const mirrorHomes = {
            systemHomePath: join(homes.tmpHome, '.codex'),
            runtimeHomePath: home
          }
          if (options?.deferConfigSync) {
            options.deferConfigSync(mirrorHomes)
          } else {
            syncSystemConfigIntoManagedCodexHome(mirrorHomes)
          }
          return home
        }
      }),
      getSettings: () => undefined
    })
    for (let index = 0; index < 3; index++) {
      expect(await prepare()).toBe(home)
    }
    writeFileSync(`${runtime}.bak`, 'model = "recoverable"\n')
    expect(await prepare()).toBe(home)
    expect(readFileSync(`${runtime}.bak`, 'utf8')).toBe('model = "recoverable"\n')
  })

  it('reports the mirrored config current only until a source edit', async () => {
    const { service, home, source } = seed()
    prepareFactoryHooks.mockImplementation(service.prepareRuntimeHomeForLaunch.bind(service))
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          options?.deferConfigSync?.({
            systemHomePath: join(homes.tmpHome, '.codex'),
            runtimeHomePath: home
          })
          return home
        }
      }),
      getSettings: () => undefined
    })
    expect(await service.isConfigPreparationCurrent(home)).toBe(false)
    for (let index = 0; index < 3; index++) {
      await prepare()
    }
    expect(await service.isConfigPreparationCurrent(home)).toBe(true)
    writeFileSync(source, 'model = "A"\n')
    expect(await service.isConfigPreparationCurrent(home)).toBe(false)
  })

  it('honors Off before effects when it changes during the asynchronous snapshot', async () => {
    const { service, home } = seed()
    await settle(service, home)
    const script = getManagedScriptPath()
    writeFileSync(script, 'stale script\n')
    let enabled = true
    controls.afterSnapshot = () => {
      enabled = false
    }
    await service.installForLaunchPrep(home, true, () => enabled)
    expect(readFileSync(script, 'utf8')).toBe('stale script\n')
  })

  it('applies source edits to both managed homes after settled launches', async () => {
    const { service, home, source, runtime } = seed()
    const other = join(homes.userDataDir, 'other-home')
    await settle(service, home)
    await settle(service, other)
    const status = await service.installForLaunchPrep(home, true, () => true)
    status.state = 'error'
    expect((await service.installForLaunchPrep(home, true, () => true)).state).toBe('installed')

    writeFileSync(source, 'model = "A"\n')
    await service.installForLaunchPrep(home, true, () => true)
    await service.installForLaunchPrep(other, true, () => true)
    expect(readFileSync(runtime, 'utf8')).toContain('model = "A"')
    expect(readFileSync(join(other, 'config.toml'), 'utf8')).toContain('model = "A"')
  })

  it('redoes the pass when the source changed while the mirror read it', async () => {
    const { service, home, source, runtime } = seed()
    await settle(service, home)
    writeFileSync(source, 'model = "A"\n')
    controls.aroundMirror = () => {
      writeFileSync(source, 'model = "B"\n')
      return () => writeFileSync(source, 'model = "A"\n')
    }
    await service.installForLaunchPrep(home, true, () => true)
    expect(readFileSync(runtime, 'utf8')).toContain('model = "A"')
    expect(readFileSync(runtime, 'utf8')).not.toContain('model = "B"')
  })

  it('takes the hooks back out when Off lands while the worker installs them', async () => {
    const { service, home } = seed()
    let enabled = true
    controls.aroundMirror = () => {
      enabled = false
      return () => {}
    }

    await service.installForLaunchPrep(home, true, () => enabled)

    expect(readFileSync(join(home, 'hooks.json'), 'utf8')).not.toContain(
      basename(getManagedScriptPath())
    )
  })

  it('keeps user hook approvals at their own slots when Off lands mid-install', async () => {
    const { service, home, source } = seed()
    const systemHooks = join(homes.tmpHome, '.codex', 'hooks.json')
    writeFileSync(
      systemHooks,
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop' }] }] } })}\n`
    )
    writeFileSync(
      source,
      upsertHookTrustContent('model = "B"\n', [
        {
          sourcePath: systemHooks,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-stop'
        }
      ])
    )
    let enabled = true
    controls.aroundMirror = () => {
      enabled = false
      return () => {}
    }

    await service.installForLaunchPrep(home, true, () => enabled)

    const runtimeHooks = join(home, 'hooks.json')
    expect(readFileSync(runtimeHooks, 'utf8')).toContain('user-stop')
    const runtimeToml = readFileSync(join(home, 'config.toml'), 'utf8')
    expect(runtimeToml).toContain(hookTrustHeader(`${runtimeHooks}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${runtimeHooks}:stop:1:0`))
  })

  it('still mirrors the launch config when the hook worker dies', async () => {
    const { service, home, runtime } = seed('C')
    mkdirSync(home, { recursive: true })
    prepareFactoryHooks.mockImplementation(service.prepareRuntimeHomeForLaunch.bind(service))
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          options?.deferConfigSync?.({
            systemHomePath: join(homes.tmpHome, '.codex'),
            runtimeHomePath: home
          })
          return home
        }
      }),
      getSettings: () => undefined
    })
    codexProjectTrustTestWorker.controls.crashesOn = (request) => request.kind === 'hookPass'
    try {
      expect(await prepare()).toBe(home)
    } finally {
      codexProjectTrustTestWorker.controls.crashesOn = () => false
    }

    expect(readFileSync(runtime, 'utf8')).toContain('model = "C"')
  })

  it.each(['temporarily absent', 'temporarily locked'] as const)(
    'retries legacy cleanup after its profile was %s',
    async (failure) => {
      const { service, home } = seed()
      await settle(service, home)
      const legacy = join(homes.tmpHome, '.codex', 'orca-agent-status.config.toml')
      writeFileSync(
        legacy,
        '# BEGIN ORCA AGENT STATUS HOOKS\nlegacy = true\n# END ORCA AGENT STATUS HOOKS\n'
      )
      controls.hideLegacy = failure === 'temporarily absent'
      controls.failLegacyDelete = failure === 'temporarily locked'
      expect((await service.installForLaunchPrep(home, true, () => true)).state).toBe('installed')
      expect(existsSync(legacy)).toBe(true)
      await service.installForLaunchPrep(home, true, () => true)
      expect(existsSync(legacy)).toBe(false)
    }
  )

  it('recovers the owed mirror on a fresh worker after the pass worker dies once', async () => {
    const { service, home, runtime } = seed('D')
    mkdirSync(home, { recursive: true })
    prepareFactoryHooks.mockImplementation(service.prepareRuntimeHomeForLaunch.bind(service))
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          options?.deferConfigSync?.({
            systemHomePath: join(homes.tmpHome, '.codex'),
            runtimeHomePath: home
          })
          return home
        }
      }),
      getSettings: () => undefined
    })
    const modes: string[] = []
    codexProjectTrustTestWorker.controls.crashesOn = (request) => {
      if (request.kind !== 'hookPass') {
        return false
      }
      modes.push(request.mode)
      return modes.length === 1
    }
    try {
      expect(await prepare()).toBe(home)
    } finally {
      codexProjectTrustTestWorker.controls.crashesOn = () => false
    }

    expect(modes).toEqual(['install', 'mirror'])
    expect(readFileSync(runtime, 'utf8')).toContain('model = "D"')
  })

  it('repairs a script another writer restored after this pass published its replacement', async () => {
    const { service, home } = seed()
    await settle(service, home)
    const script = getManagedScriptPath()
    writeFileSync(script, 'stale script\n')
    controls.afterCleanup = () => writeFileSync(script, 'stale script\n')
    await service.installForLaunchPrep(home, true, () => true)
    expect(readFileSync(script, 'utf8')).toBe('stale script\n')
    await service.installForLaunchPrep(home, true, () => true)
    expect(readFileSync(script, 'utf8')).not.toContain('stale script')
  })

  it.skipIf(process.platform === 'win32')(
    'rekeys approvals after a same-byte home symlink moves',
    async () => {
      const { service, home } = seed()
      const first = join(homes.userDataDir, 'first')
      const second = join(homes.userDataDir, 'second')
      mkdirSync(first)
      symlinkSync(first, home)
      await settle(service, home)
      cpSync(first, second, { recursive: true })
      unlinkSync(home)
      symlinkSync(second, home)
      await service.installForLaunchPrep(home, true, () => true)
      const toml = readFileSync(join(home, 'config.toml'), 'utf8')
      expect(toml).toContain(`${second}/hooks.json:stop:0:0`)
    }
  )
})
