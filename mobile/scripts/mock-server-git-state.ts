import type { MobileGitStatusEntry } from '../src/source-control/mobile-git-status'

type FakeGitEntry = MobileGitStatusEntry & {
  stagedFromUntracked?: boolean
}

type MockGitRequest = {
  id: string
  method: string
  params?: Record<string, unknown>
}

type MockGitResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  _meta: { runtimeId: string }
}

type MockGitRespond = (response: MockGitResponse) => void
type MockGitSuccess = (id: string, result: unknown) => MockGitResponse

let fakeGitEntries: FakeGitEntry[] = [
  { path: 'src/auth/middleware.ts', status: 'modified', area: 'unstaged' },
  { path: 'src/auth/jwt.ts', status: 'untracked', area: 'untracked' },
  { path: 'README.md', status: 'modified', area: 'staged' }
]
let fakeAhead = 1
let fakeBehind = 0
let fakeHasUpstream = true

function toGitStatusEntry(entry: FakeGitEntry): MobileGitStatusEntry {
  const { stagedFromUntracked: _stagedFromUntracked, ...statusEntry } = entry
  return statusEntry
}

function stageFakeGitEntry(entry: FakeGitEntry, filePaths: Set<string>): FakeGitEntry {
  if (!filePaths.has(entry.path)) {
    return entry
  }
  if (entry.area === 'untracked') {
    return { ...entry, area: 'staged', status: 'added', stagedFromUntracked: true }
  }
  return { ...entry, area: 'staged' }
}

function unstageFakeGitEntry(entry: FakeGitEntry, filePaths: Set<string>): FakeGitEntry {
  if (!filePaths.has(entry.path)) {
    return entry
  }
  if (entry.stagedFromUntracked) {
    return { ...entry, area: 'untracked', status: 'untracked', stagedFromUntracked: false }
  }
  return { ...entry, area: 'unstaged' }
}

export function handleMockGitRequest(
  request: MockGitRequest,
  respond: MockGitRespond,
  success: MockGitSuccess
): boolean {
  switch (request.method) {
    case 'git.status':
      respond(
        success(request.id, {
          entries: fakeGitEntries.map(toGitStatusEntry),
          conflictOperation: 'unknown',
          branch: 'refs/heads/feature/auth-refactor',
          upstreamStatus: {
            hasUpstream: fakeHasUpstream,
            upstreamName: 'origin/feature/auth-refactor',
            ahead: fakeAhead,
            behind: fakeBehind
          }
        })
      )
      return true

    case 'git.upstreamStatus':
      respond(
        success(request.id, {
          hasUpstream: fakeHasUpstream,
          upstreamName: 'origin/feature/auth-refactor',
          ahead: fakeAhead,
          behind: fakeBehind
        })
      )
      return true

    case 'git.stage': {
      const filePath = String(request.params?.filePath ?? '')
      fakeGitEntries = fakeGitEntries.map((entry) => stageFakeGitEntry(entry, new Set([filePath])))
      respond(success(request.id, { ok: true }))
      return true
    }

    case 'git.bulkStage': {
      const filePaths = new Set((request.params?.filePaths as string[] | undefined) ?? [])
      fakeGitEntries = fakeGitEntries.map((entry) => stageFakeGitEntry(entry, filePaths))
      respond(success(request.id, { ok: true }))
      return true
    }

    case 'git.unstage': {
      const filePath = String(request.params?.filePath ?? '')
      fakeGitEntries = fakeGitEntries.map((entry) =>
        unstageFakeGitEntry(entry, new Set([filePath]))
      )
      respond(success(request.id, { ok: true }))
      return true
    }

    case 'git.bulkUnstage': {
      const filePaths = new Set((request.params?.filePaths as string[] | undefined) ?? [])
      fakeGitEntries = fakeGitEntries.map((entry) => unstageFakeGitEntry(entry, filePaths))
      respond(success(request.id, { ok: true }))
      return true
    }

    case 'git.discard': {
      const filePath = String(request.params?.filePath ?? '')
      fakeGitEntries = fakeGitEntries.filter((entry) => entry.path !== filePath)
      respond(success(request.id, { ok: true }))
      return true
    }

    case 'git.commit':
      fakeGitEntries = fakeGitEntries.filter((entry) => entry.area !== 'staged')
      fakeAhead += 1
      respond(success(request.id, { success: true }))
      return true

    case 'git.fetch':
      respond(success(request.id, { ok: true }))
      return true

    case 'git.pull':
      fakeBehind = 0
      respond(success(request.id, { ok: true }))
      return true

    case 'git.diff':
      respond(
        success(request.id, {
          kind: 'text',
          originalContent: 'const status = "old"\\n',
          modifiedContent: 'const status = "new"\\n',
          originalIsBinary: false,
          modifiedIsBinary: false
        })
      )
      return true

    case 'git.push':
      fakeHasUpstream = true
      fakeAhead = 0
      respond(success(request.id, { ok: true }))
      return true

    default:
      return false
  }
}
