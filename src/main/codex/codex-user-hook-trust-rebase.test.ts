import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookCommandConfig, HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexUserHookTrustRebaseRequest } from './codex-user-hook-trust-rebase-client'

const resolveCodexCommandMock = vi.hoisted(() => vi.fn(() => process.execPath))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))

import { codexAppServerCapabilityCache } from './codex-app-server-capability-cache'
import { CodexAppServerUnsupportedError } from './codex-app-server-session'
import {
  _internals,
  getMovedCodexUserHookTrust,
  mutateRealHomeHooksPreservingUserTrust
} from './codex-user-hook-trust-rebase'

let root: string
let hooksPath: string
let configPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-user-hook-rebase-'))
  hooksPath = join(root, 'hooks.json')
  configPath = join(root, 'config.toml')
})

afterEach(() => {
  _internals.setSessionRunnerSync(null)
  _internals.resetRetryState()
  codexAppServerCapabilityCache.clear()
  rmSync(root, { recursive: true, force: true })
})

function command(command: string): HookCommandConfig {
  return { type: 'command', command }
}

describe('real-home user hook trust rebasing', () => {
  it('writes directly without reading config or spawning Codex when user positions stay stable', () => {
    const user = command('user-hook')
    const orca = command('orca-hook')
    const before = { Stop: [{ hooks: [user] }] }
    const after = { Stop: [{ hooks: [user] }, { hooks: [orca] }] }
    let wroteHooks = false
    _internals.setSessionRunnerSync(() => {
      throw new Error('stable positions must not open an app-server session')
    })

    expect(
      mutateRealHomeHooksPreservingUserTrust({
        sourcePath: hooksPath,
        runtimeHomePath: root,
        tomlPath: configPath,
        beforeHooks: before,
        afterHooks: after,
        writeHooks: () => {
          wroteHooks = true
        },
        restoreHooks: () => {
          throw new Error('restore must not run')
        }
      })
    ).toBeNull()
    expect(wroteHooks).toBe(true)
    expect(existsSync(configPath)).toBe(false)
  })

  it('finds multiple shifted user hooks, including a handler from a mixed group', () => {
    const orca = command('orca-hook')
    const first = command('first-user')
    const second = command('second-user')
    const mixed = command('mixed-user')
    const before: Record<string, HookDefinition[]> = {
      Stop: [{ hooks: [orca] }, { hooks: [first] }, { hooks: [second] }, { hooks: [orca, mixed] }]
    }
    const after: Record<string, HookDefinition[]> = {
      Stop: [{ hooks: [first] }, { hooks: [second] }, { hooks: [mixed] }]
    }

    expect(getMovedCodexUserHookTrust(hooksPath, before, after)).toEqual([
      expect.objectContaining({
        command: 'first-user',
        oldKey: expect.stringContaining(':1:0'),
        newKey: expect.stringContaining(':0:0')
      }),
      expect.objectContaining({
        command: 'second-user',
        oldKey: expect.stringContaining(':2:0'),
        newKey: expect.stringContaining(':1:0')
      }),
      expect.objectContaining({
        command: 'mixed-user',
        oldKey: expect.stringContaining(':3:1'),
        newKey: expect.stringContaining(':2:0')
      })
    ])
  })

  it('carries only previously trusted states into the repair request', () => {
    const orca = command('orca-hook')
    const trusted = command('trusted-user')
    const untrusted = command('untrusted-user')
    const before = { Stop: [{ hooks: [orca] }, { hooks: [trusted] }, { hooks: [untrusted] }] }
    const after = { Stop: [{ hooks: [trusted] }, { hooks: [untrusted] }] }
    writeFileSync(hooksPath, `${JSON.stringify({ hooks: before }, null, 2)}\n`)
    writeFileSync(configPath, '# original config\n')
    const requests: CodexUserHookTrustRebaseRequest[] = []
    _internals.setSessionRunnerSync((request) => {
      requests.push(request)
      if (request.operation === 'inspect-user-hook-trust') {
        return {
          outcome: 'inspected',
          moves: request.moves.map((move) => ({
            ...move,
            reportedOldKey: move.oldKey,
            wasTrusted: move.command === 'trusted-user',
            enabled: move.command !== 'untrusted-user'
          }))
        }
      }
      return { outcome: 'repaired', repaired: 1 }
    })

    mutateRealHomeHooksPreservingUserTrust({
      sourcePath: hooksPath,
      runtimeHomePath: root,
      tomlPath: configPath,
      beforeHooks: before,
      afterHooks: after,
      writeHooks: () => writeFileSync(hooksPath, `${JSON.stringify({ hooks: after }, null, 2)}\n`),
      restoreHooks: () => {
        throw new Error('restore must not run')
      }
    })

    expect(requests).toHaveLength(2)
    expect(requests[0]?.invocation.envToDelete).toContain('CODEX_HOME')
    const repair = requests[1]
    expect(repair?.operation).toBe('repair-user-hook-trust')
    if (repair?.operation === 'repair-user-hook-trust') {
      expect(repair.moves).toEqual([
        expect.objectContaining({ command: 'trusted-user', wasTrusted: true, enabled: true }),
        expect.objectContaining({ command: 'untrusted-user', wasTrusted: false, enabled: false })
      ])
    }
  })

  it('marks the host unsupported and skips further codex sessions', () => {
    const orca = command('orca-hook')
    const user = command('user-hook')
    const before = { Stop: [{ hooks: [orca] }, { hooks: [user] }] }
    const after = { Stop: [{ hooks: [user] }] }
    writeFileSync(configPath, '# config\n')
    let sessions = 0
    _internals.setSessionRunnerSync(() => {
      sessions += 1
      throw new CodexAppServerUnsupportedError('unrecognized subcommand app-server')
    })
    const args = {
      sourcePath: hooksPath,
      runtimeHomePath: root,
      tomlPath: configPath,
      beforeHooks: before,
      afterHooks: after,
      writeHooks: () => {
        throw new Error('write must not run')
      },
      restoreHooks: () => {
        throw new Error('restore must not run')
      }
    }

    expect(() => mutateRealHomeHooksPreservingUserTrust(args)).toThrow('unrecognized subcommand')
    expect(() => mutateRealHomeHooksPreservingUserTrust(args)).toThrow('marked unsupported')
    expect(sessions).toBe(1)
    expect(codexAppServerCapabilityCache.shouldTry('native')).toBe(false)
  })

  it('cools down after a transient session failure instead of retrying every launch prep', () => {
    const orca = command('orca-hook')
    const user = command('user-hook')
    const before = { Stop: [{ hooks: [orca] }, { hooks: [user] }] }
    const after = { Stop: [{ hooks: [user] }] }
    writeFileSync(configPath, '# config\n')
    let sessions = 0
    _internals.setSessionRunnerSync(() => {
      sessions += 1
      throw new Error('pre-mutation hooks/list reported 0 of 1 moved user hooks')
    })
    const args = {
      sourcePath: hooksPath,
      runtimeHomePath: root,
      tomlPath: configPath,
      beforeHooks: before,
      afterHooks: after,
      writeHooks: () => {
        throw new Error('write must not run')
      },
      restoreHooks: () => {
        throw new Error('restore must not run')
      }
    }

    expect(() => mutateRealHomeHooksPreservingUserTrust(args)).toThrow('0 of 1 moved user hooks')
    expect(() => mutateRealHomeHooksPreservingUserTrust(args)).toThrow('cooling down')
    expect(sessions).toBe(1)
    // Why: a transient failure must not poison the shared capability signal.
    expect(codexAppServerCapabilityCache.shouldTry('native')).toBe(true)
  })

  it('restores both files byte-exactly when post-mutation repair fails', () => {
    const orca = command('orca-hook')
    const user = command('user-hook')
    const before = { Stop: [{ hooks: [orca] }, { hooks: [user] }] }
    const after = { Stop: [{ hooks: [user] }] }
    const originalHooks =
      '{ "hooks": { "Stop": [{"hooks":[{"type":"command","command":"orca-hook"}]},{"hooks":[{"type":"command","command":"user-hook"}]}] } }\r\n'
    const originalConfig = '# user formatting\r\nmodel = "x"\r\n'
    writeFileSync(hooksPath, originalHooks)
    writeFileSync(configPath, originalConfig)
    _internals.setSessionRunnerSync((request) => {
      if (request.operation === 'inspect-user-hook-trust') {
        return {
          outcome: 'inspected',
          moves: request.moves.map((move) => ({
            ...move,
            reportedOldKey: move.oldKey,
            wasTrusted: true,
            enabled: true
          }))
        }
      }
      writeFileSync(configPath, '[hooks.state."partial"]\ntrusted_hash = "bad"\n')
      throw new Error('repair transport failed')
    })

    expect(() =>
      mutateRealHomeHooksPreservingUserTrust({
        sourcePath: hooksPath,
        runtimeHomePath: root,
        tomlPath: configPath,
        beforeHooks: before,
        afterHooks: after,
        writeHooks: () => writeFileSync(hooksPath, `${JSON.stringify({ hooks: after })}\n`),
        restoreHooks: () => writeFileSync(hooksPath, originalHooks)
      })
    ).toThrow('repair transport failed')
    expect(readFileSync(hooksPath, 'utf-8')).toBe(originalHooks)
    expect(readFileSync(configPath, 'utf-8')).toBe(originalConfig)
  })
})
