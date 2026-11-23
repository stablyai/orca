// Builds a synthetic fleet profile through the app's own APIs: 1,800 worktrees, 100 folders, chat tabs at rest, 200 terminals.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { lockCacheEntry } from './fleet-gate-cache-lock.mjs'
import { copyProfile } from './fleet-gate-copies.mjs'

export const SEED_SHAPE = { worktrees: 1_800, folders: 100, chats: 1_800, terminals: 200 }
const SEED_FORMAT = 2

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** One small repo with linked worktrees plus plain folders; paths stay fixed so every seed built on it stays valid. */
export function ensureFleetCorpus(corpusDir) {
  const marker = path.join(corpusDir, '.fleet-corpus-ready')
  fs.mkdirSync(path.dirname(corpusDir), { recursive: true })
  const unlock = lockCacheEntry(corpusDir)
  try {
    if (!fs.existsSync(marker)) {
      buildCorpus(corpusDir, marker)
    }
  } finally {
    unlock()
  }
  return corpusDir
}

function buildCorpus(corpusDir, marker) {
  fs.rmSync(corpusDir, { recursive: true, force: true })
  const repo = path.join(corpusDir, 'fleet-repo')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  git(corpusDir, ['init', '-q', '-b', 'main', repo])
  git(repo, ['config', 'user.email', 'fleet-gate@example.invalid'])
  git(repo, ['config', 'user.name', 'Fleet Gate'])
  for (let index = 1; index <= 20; index += 1) {
    fs.writeFileSync(path.join(repo, 'src', `f${index}.ts`), `export const v${index} = ${index}\n`)
  }
  fs.writeFileSync(path.join(repo, 'README.md'), '# fleet repo\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  for (let index = 1; index <= SEED_SHAPE.worktrees; index += 1) {
    const name = `wt-${String(index).padStart(4, '0')}`
    git(repo, ['worktree', 'add', '-q', '-b', name, path.join(corpusDir, 'wt', name), 'main'])
  }
  for (let index = 1; index <= SEED_SHAPE.folders; index += 1) {
    const folder = path.join(corpusDir, 'folders', `folder-${String(index).padStart(3, '0')}`)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'notes.txt'), `notes ${index}\n`)
  }
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`)
}

/** What a full seed holds; a receipt short of it, cached before this check existed, is rebuilt. */
function seedShortfall({ census, chats, terminals }) {
  return [
    !(census?.workspaces >= SEED_SHAPE.worktrees + SEED_SHAPE.folders) && 'workspaces',
    !(chats?.ok >= SEED_SHAPE.chats) && 'chats',
    !(terminals?.ok >= SEED_SHAPE.terminals) && 'terminals'
  ].filter(Boolean)
}

export function readSeedReceipt(seedDir) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(seedDir, '.fleet-seed.json'), 'utf8'))
    return receipt.format === SEED_FORMAT && seedShortfall(receipt).length === 0 ? receipt : null
  } catch {
    return null
  }
}

export function completedOnboardingProfile() {
  return {
    settings: {
      telemetry: {
        optedIn: false,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: false
      }
    },
    onboarding: { flowVersion: 2, closedAt: 1, outcome: 'completed', lastCompletedStep: 3 },
    ui: {
      contextualToursSeenIds: [
        'workspace-board',
        'browser',
        'tasks',
        'automations',
        'workspace-creation'
      ],
      contextualToursAutoEligible: false,
      projectOrderManualDefaultNoticeDismissed: true
    }
  }
}

async function addWorkspaces(page, corpusDir) {
  return page.evaluate(
    async ({ repoPath, folderRoot, folders }) => {
      const store = window.__store
      const added = await window.api.repos.add({ path: repoPath, kind: 'git' })
      if ('error' in added) {
        throw new Error(`repo add failed: ${JSON.stringify(added.error)}`)
      }
      await store.getState().fetchRepos({ runtimeEnvironmentId: null })
      await store.getState().fetchWorktrees(added.repo.id, { requireAuthoritative: true })
      const imported = (store.getState().detectedWorktreesByRepo[added.repo.id]?.worktrees ?? [])
        .filter((worktree) => !worktree.selectedCheckout)
        .map((worktree) => worktree.path)
      await store.getState().updateRepo(added.repo.id, {
        externalWorktreeVisibility: 'show',
        importedExternalWorktreePaths: imported,
        externalWorktreeInboxBaselinePaths: imported
      })
      await store.getState().fetchWorktrees(added.repo.id, { requireAuthoritative: true })
      let folderErrors = 0
      for (let index = 1; index <= folders; index += 1) {
        const folderPath = `${folderRoot}/folder-${String(index).padStart(3, '0')}`
        const result = await window.api.repos.add({ path: folderPath, kind: 'folder' })
        if (!result?.repo?.id) {
          folderErrors += 1
        }
      }
      return { imported: imported.length, folderErrors }
    },
    {
      repoPath: path.join(corpusDir, 'fleet-repo'),
      folderRoot: path.join(corpusDir, 'folders'),
      folders: SEED_SHAPE.folders
    }
  )
}

// Chats are created at rest through agentSession.create, so no provider process runs.
async function seedChats(page, count) {
  return page.evaluate(async (total) => {
    const canon = (value) =>
      value === null || typeof value !== 'object'
        ? JSON.stringify(value ?? null)
        : Array.isArray(value)
          ? `[${value.map(canon).join(',')}]`
          : `{${Object.entries(value)
              .filter(([, entry]) => entry !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => `${JSON.stringify(key)}:${canon(entry)}`)
              .join(',')}}`
    const sha = async (text) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    const list = await window.api.runtime.call({ method: 'worktree.list', params: { limit: 5000 } })
    const worktrees = list.result.worktrees.sort((a, b) => (a.path < b.path ? -1 : 1))
    const out = { ok: 0, errors: {} }
    for (let index = 0; index < Math.min(total, worktrees.length); index += 1) {
      const fields = {
        worktree: `id:${worktrees[index].id}`,
        agent: index % 2 === 0 ? 'claude' : 'codex'
      }
      const sessionId = crypto.randomUUID()
      const payloadFingerprint = await sha(
        canon({ method: 'agentSession.create', sessionId, fields })
      )
      const params = {
        envelope: {
          sessionId,
          clientOperationId: `${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`,
          expectedRuntimeFence: null,
          payloadFingerprint
        },
        ...fields
      }
      try {
        const response = await window.api.runtime.call({ method: 'agentSession.create', params })
        if (response.ok && response.result?.ok !== false) {
          out.ok += 1
        } else {
          const key = JSON.stringify(response.error ?? response.result?.refusal ?? response).slice(
            0,
            200
          )
          out.errors[key] = (out.errors[key] ?? 0) + 1
        }
      } catch (error) {
        const key = `throw ${String(error?.message).slice(0, 200)}`
        out.errors[key] = (out.errors[key] ?? 0) + 1
      }
    }
    return out
  }, count)
}

async function seedTerminals(page, count) {
  return page.evaluate(async (total) => {
    const list = await window.api.runtime.call({ method: 'worktree.list', params: { limit: 5000 } })
    const worktrees = list.result.worktrees
      .filter((worktree) => /\/wt\/wt-\d{4}$/.test(worktree.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .slice(0, total)
    let ok = 0
    for (const worktree of worktrees) {
      const response = await window.api.runtime.call({
        method: 'terminal.create',
        params: { worktree: `id:${worktree.id}`, clientMutationId: crypto.randomUUID() }
      })
      if (response.ok) {
        ok += 1
      }
    }
    return { ok }
  }, count)
}

export async function readFleetCensus(page) {
  return page.evaluate(async () => {
    const tabs = await window.api.runtime.call({ method: 'session.tabs.listAll', params: {} })
    let chatTabs = 0
    let terminalTabs = 0
    for (const snapshot of tabs.result?.snapshots ?? []) {
      for (const tab of snapshot.tabs ?? []) {
        if (tab.type === 'terminal') {
          terminalTabs += 1
        } else {
          chatTabs += 1
        }
      }
    }
    const list = await window.api.runtime.call({ method: 'worktree.list', params: { limit: 5000 } })
    return { workspaces: list.result?.totalCount ?? null, chatTabs, terminalTabs }
  })
}

/**
 * Seeds through a launched app; launch() returns { app, page } with page session-ready, close() quits it gracefully.
 * The app runs on workDir inside the gate's run folder, never the shared seed cache, so a reap of this gate never
 * touches another gate's seed; the finished profile is copied into seedDir.
 */
export async function buildSyntheticFleetSeed({ seedDir, workDir, corpusDir, builtBy, launch }) {
  ensureFleetCorpus(corpusDir)
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(
    path.join(workDir, 'orca-data.json'),
    `${JSON.stringify(completedOnboardingProfile(), null, 2)}\n`
  )
  const { page, close } = await launch(workDir)
  try {
    const workspaces = await addWorkspaces(page, corpusDir)
    const chats = await seedChats(page, SEED_SHAPE.chats)
    const terminals = await seedTerminals(page, SEED_SHAPE.terminals)
    const census = await readFleetCensus(page)
    const receipt = { format: SEED_FORMAT, builtBy, workspaces, chats, terminals, census }
    // A short fleet must never be cached: every later run would measure it as if it were full size.
    const short = seedShortfall(receipt)
    if (short.length > 0) {
      throw new Error(`seed is short of ${short.join(', ')}: ${JSON.stringify(receipt)}`)
    }
    await close()
    fs.rmSync(seedDir, { recursive: true, force: true })
    copyProfile(workDir, seedDir)
    fs.writeFileSync(
      path.join(seedDir, '.fleet-seed.json'),
      `${JSON.stringify(receipt, null, 2)}\n`
    )
    return receipt
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
