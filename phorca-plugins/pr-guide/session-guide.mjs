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

export async function createSessionGuide(prUrl, sessionId = process.env.CODEX_SESSION_ID ?? process.env.CLAUDE_SESSION_ID) {
  const orca = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const current = JSON.parse(await runCli(orca, ['worktree', 'current', '--json']))
  if (!current.ok || !current.result?.worktree) {
    throw new Error('Run this command from an Orca-managed worktree.')
  }
  const worktree = current.result.worktree
  const number = checkAssociation(prUrl, worktree, sessionId)
  const result = {
    ...await generateGuide(prUrl),
    sessionId,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    worktreeBranch: worktree.branch
  }
  const file = await saveGuide(result)
  await saveSnapshot(result, file)
  if (worktree.linkedPR == null) {
    const linked = JSON.parse(await runCli(orca, [
      'worktree', 'set', '--worktree', `id:${worktree.id}`, '--pr', String(number), '--json'
    ]))
    if (!linked.ok) throw new Error(`Guide saved at ${file}, but Orca could not link PR #${number}.`)
  }
  const viewer = await startViewer(result, {
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
