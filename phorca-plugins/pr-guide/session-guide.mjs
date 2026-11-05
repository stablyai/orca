import { pathToFileURL } from 'node:url'
import { generateGuide, openViewerUrl, parsePrUrl, runCli, saveGuide } from './main.mjs'
import { saveSnapshot, startViewer } from './viewer.mjs'

export function checkAssociation(prUrl, worktree, sessionId) {
  const [, owner, repo, , number] = new URL(parsePrUrl(prUrl)).pathname.split('/')
  if (worktree.projectId?.toLowerCase() !== `github:${owner}/${repo}`.toLowerCase()) {
    throw new Error('The PR belongs to a different repository than this worktree.')
  }
  if (worktree.linkedPR != null && Number(worktree.linkedPR) !== Number(number)) {
    throw new Error(`This worktree is already linked to PR #${worktree.linkedPR}.`)
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId ?? '')) {
    throw new Error('A session ID is required. Pass it as the second argument.')
  }
  return Number(number)
}

export async function linkIfUnlinked(prUrl, worktree, sessionId, run = runCli) {
  if (worktree.linkedPR != null) return
  const orca = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const latest = JSON.parse(await run(orca, ['worktree', 'show', '--worktree', `id:${worktree.id}`, '--json']))
  if (!latest.ok || !latest.result?.worktree) throw new Error('The worktree could not be rechecked before linking the PR.')
  const number = checkAssociation(prUrl, latest.result.worktree, sessionId)
  if (latest.result.worktree.linkedPR != null) return
  const linked = JSON.parse(await run(orca, [
    'worktree', 'set', '--worktree', `id:${worktree.id}`, '--pr', String(number), '--json'
  ]))
  if (!linked.ok) throw new Error(`Orca could not link PR #${number}.`)
}

export function sessionLocalAccess(worktreeId, run = runCli) {
  const orca = process.platform === 'win32' ? 'orca.exe' : 'orca'
  return {
    listSessions: async () => {
      const listed = JSON.parse(await run(orca, ['terminal', 'list', '--worktree', `id:${worktreeId}`, '--json']))
      if (!listed.ok || !Array.isArray(listed.result?.terminals)) throw new Error('Could not list local agent sessions.')
      return listed.result.terminals
        .filter((terminal) => terminal.agentIdentity && terminal.connected && terminal.writable && !terminal.orphaned)
        .map(({ handle, title, agentIdentity }) => ({ handle, title, agentIdentity }))
    },
    sendSession: async (terminal, text) => {
      const receipt = JSON.parse(await run(orca, ['terminal', 'send', '--terminal', terminal.handle, '--text', text, '--enter', '--json']))
      return { accepted: receipt.ok && receipt.result?.send?.accepted }
    }
  }
}

export async function createSessionGuide(prUrl, sessionId = process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID) {
  const orca = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const current = JSON.parse(await runCli(orca, ['worktree', 'current', '--json']))
  if (!current.ok || !current.result?.worktree) {
    throw new Error('Run this command from an Orca-managed worktree.')
  }
  const worktree = current.result.worktree
  checkAssociation(prUrl, worktree, sessionId)
  const result = {
    ...await generateGuide(prUrl),
    sessionId,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    worktreeBranch: worktree.branch
  }
  const file = await saveGuide(result)
  await saveSnapshot(result, file)
  try { await linkIfUnlinked(prUrl, worktree, sessionId) }
  catch (error) { throw new Error(`Guide saved at ${file}, but ${error.message}`) }
  const viewer = await startViewer(result, {
    ...sessionLocalAccess(worktree.id),
    onRefresh: async (updated) => {
      const next = {
        ...updated,
        sessionId,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch
      }
      const nextFile = await saveGuide(next)
      await saveSnapshot(next, nextFile)
      return next
    }
  })
  try {
    const tab = JSON.parse(await runCli(orca, [
      'tab', 'create', '--worktree', `id:${worktree.id}`, '--url', viewer.url, '--json'
    ]))
    if (!tab.ok) throw new Error('Could not open the Phorca browser tab.')
  } catch {
    openViewerUrl(viewer.url)
  }
  return { file, url: viewer.url }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createSessionGuide(process.argv[2], process.argv[3])
    .then(({ file, url }) => console.log(`Guide: ${file}\nViewer: ${url}\nKeep this process running while commenting.`))
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
