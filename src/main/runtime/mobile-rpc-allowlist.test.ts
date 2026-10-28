import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ALL_RPC_METHODS } from './rpc/methods'
import { MOBILE_RPC_METHOD_ALLOWLIST } from './runtime-rpc/runtime-rpc-mobile-method-allowlist'

const MOBILE_DYNAMIC_RPC_METHODS = [
  // Computed sendRequest names evade the literal source scan.
  'accounts.selectClaude',
  'accounts.selectCodex',
  'accounts.selectCodexForTarget',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'github.updateIssue',
  'github.updatePRState',
  'gitlab.updateIssue',
  'gitlab.updateMR',
  // GitHub wrappers pass names positionally, outside the literal sendRequest scan.
  'github.repoSlug',
  'github.prForBranch',
  'github.workItemDetails',
  'github.prChecks',
  'github.prCheckDetails',
  'github.listAssignableUsers',
  'github.markPRReadyForReview',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.rerunPRChecks',
  'github.updatePRTitle',
  'github.addPRReviewCommentReply',
  'github.addIssueComment',
  'github.resolveReviewThread',
  'github.project.updateIssueCommentBySlug',
  'github.project.deleteIssueCommentBySlug',
  'hostedReview.forBranch',
  'runtime.clientCapabilities.update',
  'agentSession.send',
  'agentSession.cancel',
  'agentSession.history',
  'agentSession.hold',
  'agentSession.release'
]

// These methods require both client and host built with ORCA_SIDEBAR_INPUTS=main.
const MOBILE_SIDEBAR_INPUTS_RPC_METHODS = [
  'sidebarInputs.read',
  'sidebarInputs.repoIcons',
  'ui.setCollapsed'
]

const MOBILE_STREAMING_CLEANUP_RPC_METHODS = [
  // Generated cleanup paths evade the literal source scan.
  'accounts.unsubscribe',
  'browser.screencast.unsubscribe',
  'notifications.unsubscribe',
  'runtime.clientEvents.unsubscribe',
  'session.tabs.unsubscribe',
  'session.tabs.unsubscribeAll',
  'terminal.unsubscribe'
]

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry) || /\.test\.[cm]?[jt]sx?$/.test(entry)) {
      continue
    }
    files.push(path)
  }
  return files
}

function mobileLiteralRpcMethods(): string[] {
  const roots = [join(process.cwd(), 'mobile/app'), join(process.cwd(), 'mobile/src')]
  const methods = new Set<string>()
  for (const file of roots.flatMap(listSourceFiles)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/sendRequest\(\s*['"]([^'"]+)/g)) {
      methods.add(match[1]!)
    }
    for (const match of source.matchAll(/subscribe\(\s*['"]([^'"]+)/g)) {
      methods.add(match[1]!)
    }
    for (const match of source.matchAll(/method:\s*['"]([^'"]+)/g)) {
      const method = match[1]!
      if (method.includes('.')) {
        methods.add(method)
      }
    }
  }
  return [...methods].sort()
}

function mobileRpcMethods(): string[] {
  return [...new Set([...mobileLiteralRpcMethods(), ...MOBILE_DYNAMIC_RPC_METHODS])]
    .filter((method) => !MOBILE_SIDEBAR_INPUTS_RPC_METHODS.includes(method))
    .sort()
}

function mobileRpcAllowlist(): ReadonlySet<string> {
  return MOBILE_RPC_METHOD_ALLOWLIST
}

function registeredRuntimeMethods(): Set<string> {
  return new Set(ALL_RPC_METHODS.map((method) => method.name))
}

describe('mobile RPC allowlist', () => {
  it('grants Jira reads while keeping credentials, writes, and desktop site selection private', () => {
    const allowed = mobileRpcAllowlist()
    for (const method of [
      'jira.status',
      'jira.listIssues',
      'jira.searchIssues',
      'jira.getIssue',
      'jira.issueComments'
    ]) {
      expect(allowed.has(method), method).toBe(true)
    }
    for (const method of [
      'jira.connect',
      'jira.disconnect',
      'jira.selectSite',
      'jira.createIssue',
      'jira.updateIssue',
      'jira.addIssueComment'
    ]) {
      expect(allowed.has(method), method).toBe(false)
    }
  })

  it('allows every RPC method used by the mobile app', () => {
    const allowed = mobileRpcAllowlist()
    const missing = mobileRpcMethods().filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  it('registers every RPC method used by the mobile app', () => {
    const registered = registeredRuntimeMethods()
    const missing = mobileRpcMethods().filter((method) => !registered.has(method))

    expect(missing).toEqual([])
  })

  it('allows and registers the sidebar feed the phone reads only in a switched-on build', async () => {
    expect(mobileLiteralRpcMethods()).toEqual(
      expect.arrayContaining(MOBILE_SIDEBAR_INPUTS_RPC_METHODS)
    )
    for (const method of MOBILE_SIDEBAR_INPUTS_RPC_METHODS) {
      expect(mobileRpcAllowlist().has(method)).toBe(false)
    }
    vi.resetModules()
    vi.doMock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
    try {
      const { MOBILE_RPC_METHOD_ALLOWLIST: switchedOn } =
        await import('./runtime-rpc/runtime-rpc-mobile-method-allowlist')
      const { ALL_RPC_METHODS: switchedOnMethods } = await import('./rpc/methods')
      const registered = new Set<string>(switchedOnMethods.map((method) => method.name))
      for (const method of MOBILE_SIDEBAR_INPUTS_RPC_METHODS) {
        expect(switchedOn.has(method)).toBe(true)
        expect(registered.has(method)).toBe(true)
      }
    } finally {
      vi.doUnmock('../../shared/sidebar-inputs-switch')
      vi.resetModules()
    }
  })

  it('allows every cleanup RPC for mobile streaming subscriptions', () => {
    const allowed = mobileRpcAllowlist()
    const missing = MOBILE_STREAMING_CLEANUP_RPC_METHODS.filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  it('does not grant mobile credentials control over host updates', () => {
    const allowed = mobileRpcAllowlist()
    expect(
      ['updater.getStatus', 'updater.check', 'updater.download', 'updater.install'].filter(
        (method) => allowed.has(method)
      )
    ).toEqual([])
  })

  it('exposes only the mobile structured agent-session surface', () => {
    expect(
      [...mobileRpcAllowlist()].filter((method) => method.startsWith('agentSession.'))
    ).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.ensure',
      'agentSession.reveal',
      'agentSession.send',
      'agentSession.cancel',
      'agentSession.queuedMessageSend',
      'agentSession.queuedMessageDelete',
      'agentSession.queuedMessageMove',
      'agentSession.queuedMessageUpdate',
      'agentSession.queuedMessageEditHold',
      'agentSession.queuedMessagesResume',
      'agentSession.close',
      'agentSession.respondToApproval',
      'agentSession.respondToQuestion',
      'agentSession.setOption',
      'agentSession.handoffStatus',
      'agentSession.options',
      'agentSession.modelCatalog',
      'agentSession.conversationCommand',
      'agentSession.commands',
      'agentSession.history',
      'agentSession.currentRequests',
      'agentSession.subscribe',
      'agentSession.unsubscribe',
      'agentSession.subscribeStatus',
      'agentSession.readVisual',
      'agentSession.item',
      'agentSession.hold',
      'agentSession.release'
    ])
    expect(mobileRpcAllowlist().has('agentSession.attach')).toBe(false)
  })

  it('lets a phone upload chat attachments and read stored images back', () => {
    expect(
      [...mobileRpcAllowlist()].filter((method) => method.startsWith('agentSessionAttachment.'))
    ).toEqual([
      'agentSessionAttachment.uploadStart',
      'agentSessionAttachment.uploadAppend',
      'agentSessionAttachment.uploadCommit',
      'agentSessionAttachment.uploadAbort',
      'agentSessionAttachment.read'
    ])
  })
})
