#!/usr/bin/env node
/**
 * SSH diff-reload E2E via localhost (macOS Remote Login).
 * Exercises relay + remote git diff + remote file watch paths.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import os from 'node:os'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9340)
const SSH_PORT = Number(process.env.SSH_PORT ?? 22)
const SSH_USER = process.env.SSH_USER ?? os.userInfo().username
const REMOTE_REPO = realpathSync(process.env.E2E_REPO_PATH ?? '/tmp/diff-reload-e2e-1780719688')

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForMonacoContains(page, text, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const texts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.monaco-editor .view-lines')).map(
        (v) => v.textContent ?? ''
      )
    )
    if (texts.join('\n').includes(text)) {
      return true
    }
    await sleep(250)
  }
  return false
}

async function main() {
  mkdirSync('/tmp/diff-reload-e2e-ssh', { recursive: true })

  // Reset remote repo state over SSH
  sh(
    `ssh -p ${SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=no ${SSH_USER}@127.0.0.1 ` +
      `"cd '${REMOTE_REPO}' && git checkout -- . 2>/dev/null; git reset HEAD . 2>/dev/null; ` +
      `echo 'alpha-v2' > alpha.txt && echo 'beta-v1' > beta.txt && git add alpha.txt && git status --short"`
  )

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) {
    throw new Error('No Orca page')
  }

  const identity = JSON.parse(
    await page.evaluate(async () => JSON.stringify(await window.api.app.getIdentity()))
  )
  if (!identity.devLabel?.includes('diff-tree-file-watcher')) {
    throw new Error(`Wrong Orca instance: ${identity.devLabel}`)
  }

  const label = `SSH localhost diff E2E ${Date.now()}`
  const ctx = await page.evaluate(
    async ({ remoteRepo, sshPort, username, label }) => {
      const store = window.__store
      const unsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const created = await window.api.ssh.addTarget({
          target: {
            label,
            host: '127.0.0.1',
            port: sshPort,
            username,
            relayGracePeriodSeconds: 1
          }
        })
        const state = await window.api.ssh.connect({ targetId: created.id })
        if (state.status !== 'connected') {
          throw new Error(`SSH not connected: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(created.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(created.id, created.label)
        store.getState().setSshTargetLabels(labels)

        const added = await window.api.repos.addRemote({
          connectionId: created.id,
          remotePath: remoteRepo,
          displayName: 'SSH diff reload localhost E2E'
        })
        if ('error' in added) {
          throw new Error(added.error)
        }

        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(added.repo.id)
        const worktrees = store.getState().worktreesByRepo[added.repo.id] ?? []
        const normalize = (p) => (p.startsWith('/tmp/') ? `/private${p}` : p)
        const wt =
          worktrees.find((w) => normalize(w.path) === normalize(remoteRepo)) ?? worktrees[0]
        if (!wt) {
          throw new Error(`remote worktree missing; saw ${worktrees.map((w) => w.path).join(', ')}`)
        }

        store.getState().setActiveWorktree(wt.id)
        store.getState().setActiveView('editor')
        store.getState().setRightSidebarOpen(true)
        store.getState().setRightSidebarTab('source-control')
        return { connectionId: created.id, worktreeId: wt.id, worktreePath: wt.path }
      } finally {
        unsub()
      }
    },
    { remoteRepo: REMOTE_REPO, sshPort: SSH_PORT, username: SSH_USER, label }
  )

  console.log('SSH context:', ctx)
  await sleep(2000)

  const results = []

  await page.evaluate(({ worktreeId, worktreePath }) => {
    const s = window.__store.getState()
    s.openDiff(worktreeId, worktreePath, 'beta.txt', 'plaintext', false)
    s.setActiveView('editor')
    s.setActiveTabType('editor')
  }, ctx)
  await sleep(4000)
  const t1 = await waitForMonacoContains(page, 'beta-v1')
  results.push(['SSH unstaged diff loads', t1])

  sh(
    `ssh -p ${SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=no ${SSH_USER}@127.0.0.1 ` +
      `"printf '%s\\n' 'beta-ssh-external-v2' > '${REMOTE_REPO}/beta.txt'"`
  )
  await sleep(4000)
  const t2 = await waitForMonacoContains(page, 'beta-ssh-external-v2')
  results.push(['SSH external edit reload', t2])

  await page.evaluate(({ worktreeId, worktreePath }) => {
    const s = window.__store.getState()
    s.openAllDiffs(worktreeId, worktreePath)
    s.setActiveView('editor')
  }, ctx)
  await sleep(3000)
  const t3 = await waitForMonacoContains(page, 'beta-ssh-external-v2')
  results.push(['SSH combined diff loads', t3])

  sh(
    `ssh -p ${SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=no ${SSH_USER}@127.0.0.1 ` +
      `"printf '%s\\n' 'beta-ssh-combined-v3' > '${REMOTE_REPO}/beta.txt'"`
  )
  await sleep(3000)
  const t4 = await waitForMonacoContains(page, 'beta-ssh-combined-v3')
  results.push(['SSH combined external watch', t4])

  await page.screenshot({ path: '/tmp/diff-reload-e2e-ssh/ssh-combined-final.png' })

  let passed = 0
  for (const [name, ok] of results) {
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
    if (ok) {
      passed += 1
    }
  }
  console.log(`\n=== SSH SUMMARY: ${passed}/${results.length} passed ===`)
  if (passed < results.length) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
