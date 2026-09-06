import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_OPERATIONS,
  type MobileWebBridgeCapability
} from '../../../src/shared/mobile-web/bridge-operation-registry'

const SHELL_DIR = resolve(__dirname)
const REAUTHORIZATION =
  /\.(?:assertHostWorkspaceBinding|assertHostRepoBinding|assertHostedTarget)\(/g
const HANDLE_RESOLUTION =
  /\.(?:hostWorkspaceId|hostRepoId|hostConnectionId|resolveGitHub|resolveGitLab|resolveLinear)\(/

/** Every module that reauthorizes an opaque handle, and how many times. Pinned so deleting a
 * reauthorization arm fails here even when the surrounding module keeps others. This counts
 * sites; it does not prove each one sits after the awaited read it guards. */
const REAUTHORIZATION_SITES: Record<string, number> = {
  'mobile-web-agent-history-resume.ts': 1,
  'mobile-web-file-operations.ts': 1,
  'mobile-web-file-write.ts': 1,
  'mobile-web-markdown-operations.ts': 2,
  'mobile-web-native-chat-binding.ts': 1,
  'mobile-web-provider-review-creation.ts': 2,
  'mobile-web-provider-review-management.ts': 1,
  'mobile-web-provider-review-operations.ts': 1,
  'mobile-web-provider-review-submission.ts': 1,
  'mobile-web-session-operations.ts': 1,
  'mobile-web-session-quick-command-operations.ts': 2,
  'mobile-web-source-control-commit-operation.ts': 1,
  'mobile-web-source-control-operations.ts': 1,
  'mobile-web-source-control-review-operations.ts': 3,
  'mobile-web-source-control-sync-operations.ts': 6,
  'mobile-web-task-item-file-operations.ts': 1,
  'mobile-web-task-item-mutation-operations.ts': 1,
  'mobile-web-task-item-review-operations.ts': 1,
  'mobile-web-task-project-mutation-operations.ts': 1,
  'mobile-web-workspace-creation-create-operations.ts': 2
}

/** Mutations whose dispatch module resolves a handle but never reauthorizes, because the handle is
 * consumed inside the single awaited host call with no window between check and use. Adding a
 * mutation forces a decision here rather than letting it default to unguarded. */
const NO_REAUTHORIZATION_WINDOW: readonly string[] = [
  'browser.back',
  'browser.dialog',
  'browser.forward',
  'browser.keyboard',
  'browser.navigate',
  'browser.pointer',
  'browser.reload',
  'file.releaseTerminalArtifact',
  'native.alert',
  'native.clipboardWrite',
  'native.hapticFeedback',
  'native.hapticSelection',
  'native.openExternal',
  'native.sessionChatDraftWrite',
  'native.terminalCustomKeysUpdate',
  'native.terminalTextScaleUpdate',
  'nativeChat.attachImage',
  'nativeChat.openFile',
  'nativeChat.pasteImages',
  'nativeChat.pendingWrite',
  'nativeChat.releaseImages',
  'settings.update',
  'sourceControl.cancelCommitMessageGeneration',
  'sourceControl.generateCommitMessage',
  'task.addLinearIssueComment',
  'task.connectLinear',
  'task.createLinearIssue',
  'task.createLinearSubIssue',
  'task.createProviderIssue',
  'task.selectLinearWorkspace',
  'task.updateIssueSource',
  'task.updateLinearIssueState',
  'task.updateResume',
  'task.updateSettings',
  'terminal.attachImage',
  'terminal.clear',
  'terminal.clipboardPaste',
  'terminal.displayMode',
  'terminal.rename',
  'workspace.creationPersistTrust',
  'workspace.creationSaveSparsePreset',
  'workspace.creationSshConnect',
  'workspace.remove',
  'workspace.update'
]

function shellSources(): Map<string, string> {
  return new Map(
    readdirSync(SHELL_DIR)
      .filter(
        (name) =>
          name.endsWith('.ts') &&
          !name.includes('.test.') &&
          !name.startsWith('mobile-web-production-')
      )
      .map((name) => [name, readFileSync(join(SHELL_DIR, name), 'utf8')])
  )
}

function dispatchModules(sources: Map<string, string>, operation: string): string[] {
  const patterns = [
    new RegExp(`operation === '${operation}'`),
    new RegExp(`case '${operation}':`),
    new RegExp(`'${operation}'(?=[,\\]])`),
    new RegExp(`^\\s*'${operation}',?$`, 'm'),
    new RegExp(`\\bstartsWith\\('${operation}'\\)`)
  ]
  return [...sources]
    .filter(([, text]) => patterns.some((pattern) => pattern.test(text)))
    .map(([name]) => name)
}

function mutations(): string[] {
  return Object.entries(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap(([capability, operations]) =>
    Object.entries(operations)
      .filter(([, kind]) => kind === 'mutation')
      .map(([operation]) => `${capability}.${operation}`)
  )
}

describe('mobile web mutation reauthorization census', () => {
  const sources = shellSources()

  it('keeps every recorded reauthorization site in place', () => {
    const derived: Record<string, number> = {}
    for (const [name, text] of sources) {
      const count = (text.match(REAUTHORIZATION) ?? []).length
      if (count > 0) {
        derived[name] = count
      }
    }

    expect(derived).toEqual(REAUTHORIZATION_SITES)
  })

  it('routes every mutation to a reauthorizing module or a recorded exemption', () => {
    const unaccounted: string[] = []
    for (const operation of mutations()) {
      if (NO_REAUTHORIZATION_WINDOW.includes(operation)) {
        continue
      }
      const modules = dispatchModules(sources, operation.slice(operation.indexOf('.') + 1))
      if (modules.length === 0) {
        unaccounted.push(`${operation} (no dispatch arm)`)
        continue
      }
      const resolving = modules.filter((name) => HANDLE_RESOLUTION.test(sources.get(name)!))
      if (resolving.length === 0) {
        continue
      }
      if (!resolving.some((name) => name in REAUTHORIZATION_SITES)) {
        unaccounted.push(`${operation} -> ${resolving.join(', ')}`)
      }
    }

    expect(unaccounted).toEqual([])
    expect(mutations().length).toBeGreaterThanOrEqual(120)
  })

  it('exempts only registered mutations', () => {
    const registered = new Set(mutations())
    const exempt = [...NO_REAUTHORIZATION_WINDOW]

    expect(exempt.filter((operation) => !registered.has(operation))).toEqual([])
    expect(new Set(exempt).size).toBe(exempt.length)
  })

  it('classifies every registered operation with a kind', () => {
    const kinds = new Set(
      Object.values(MOBILE_WEB_BRIDGE_OPERATIONS).flatMap((operations) => Object.values(operations))
    )
    const capabilities = Object.keys(MOBILE_WEB_BRIDGE_OPERATIONS) as MobileWebBridgeCapability[]

    expect([...kinds].sort()).toEqual(['mutation', 'read', 'subscription'])
    expect(capabilities).toHaveLength(15)
  })
})
