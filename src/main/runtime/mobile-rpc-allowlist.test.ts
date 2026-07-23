import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from './rpc/methods'

const MOBILE_DYNAMIC_RPC_METHODS = [
  // Why: computed sendRequest method names do not appear as literals in the
  // mobile source scan below, but still must stay mobile-authorized.
  'accounts.selectClaude',
  'accounts.selectCodex',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'github.updateIssue',
  'github.updatePRState',
  'gitlab.updateIssue',
  'gitlab.updateMR',
  // PR-sidebar reads/mutations: the mobile github-pr-rpc/mutations wrappers pass
  // the method name as a positional arg to sendGithubPrRead/sendMutation, so the
  // literal sendRequest('...') scan below cannot see them. List them here so the
  // allowlist + registration are still enforced.
  'github.repoSlug',
  'github.prForBranch',
  'github.workItemDetails',
  'github.prChecks',
  'github.prCheckDetails',
  'github.listAssignableUsers',
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
  'hostedReview.forBranch'
]

const MOBILE_STREAMING_CLEANUP_RPC_METHODS = [
  // Why: shared-control unsubscribe methods are sent from generated cleanup
  // paths, so literal mobile source scanning cannot discover every one.
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
  return [...new Set([...mobileLiteralRpcMethods(), ...MOBILE_DYNAMIC_RPC_METHODS])].sort()
}

function mobileRpcAllowlist(): Set<string> {
  const source = readFileSync(join(process.cwd(), 'src/main/runtime/runtime-rpc.ts'), 'utf8')
  const allowlist = source.match(/const MOBILE_RPC_METHOD_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
  if (!allowlist) {
    throw new Error('MOBILE_RPC_METHOD_ALLOWLIST not found')
  }
  return new Set([...allowlist[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!))
}

function registeredRuntimeMethods(): Set<string> {
  return new Set(ALL_RPC_METHODS.map((method) => method.name))
}

describe('mobile RPC allowlist', () => {
  it('allows every RPC method used by the mobile app', () => {
    // Why: mobile-scoped runtime tokens are checked before dispatch. A mobile
    // feature can compile and still fail at runtime if its method is missing here.
    const allowed = mobileRpcAllowlist()
    const missing = mobileRpcMethods().filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  it('registers every RPC method used by the mobile app', () => {
    // Why: the allowlist check runs before dispatch, but an allowlisted mobile
    // method still fails at runtime if it was never added to ALL_RPC_METHODS.
    const registered = registeredRuntimeMethods()
    const missing = mobileRpcMethods().filter((method) => !registered.has(method))

    expect(missing).toEqual([])
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
})
