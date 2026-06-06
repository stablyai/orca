#!/usr/bin/env node
/**
 * SSH E2E verification for diff reload (#4730) against a throwaway Linux container.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9340)
const SSH_PORT = Number(process.env.SSH_PORT ?? 2223)
const CONTAINER = process.env.SSH_CONTAINER ?? 'orca-diff-ssh-e2e'
const RUN_DIR = process.env.SSH_RUN_DIR ?? `/tmp/orca-diff-ssh-${Date.now()}`
const LOCAL_REPO = realpathSync(process.env.E2E_REPO_PATH ?? '/tmp/diff-reload-e2e-1780719688')

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForMonacoContains(page, text, timeoutMs = 12_000) {
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

function setupSshContainer() {
  mkdirSync(RUN_DIR, { recursive: true })
  const keyPath = join(RUN_DIR, 'id_ed25519')
  sh(`ssh-keygen -t ed25519 -N "" -f "${keyPath}"`)
  const pubKey = readFileSync(`${keyPath}.pub`, 'utf8').trim()

  sh(`docker rm -f ${CONTAINER} 2>/dev/null || true`)
  sh(
    `docker run -d --name ${CONTAINER} -p ${SSH_PORT}:22 ` +
      `-e PUID=0 -e PGID=0 -e TZ=UTC ` +
      `-e PUBLIC_KEY="${pubKey}" ` +
      `-e USER_NAME=orca -e PASSWORD_ACCESS=false ` +
      `lscr.io/linuxserver/openssh-server:latest`
  )

  for (let i = 0; i < 30; i += 1) {
    try {
      sh(
        `ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=2 orca@127.0.0.1 true`
      )
      break
    } catch {
      execSync('sleep 1')
    }
  }

  const remoteRepo = '/work/diff-reload-e2e'
  sh(
    `ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no orca@127.0.0.1 ` +
      `"rm -rf ${remoteRepo} && mkdir -p ${remoteRepo}"`
  )
  sh(
    `tar -C "${LOCAL_REPO}" -cf - . | ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no orca@127.0.0.1 ` +
      `"tar -xf - -C ${remoteRepo}"`
  )
  sh(
    `ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no orca@127.0.0.1 ` +
      `"cd ${remoteRepo} && git status --short"`
  )

  return { keyPath, remoteRepo }
}

async function main() {
  console.log('Setting up SSH container...')
  const { keyPath, remoteRepo } = setupSshContainer()

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

  const ctx = await page.evaluate(
    async ({ remoteRepo, sshPort, identityFile, label }) => {
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
            username: 'orca',
            identityFile,
            relayGracePeriodSeconds: 1
          }
        })
        let state = await window.api.ssh.connect({ targetId: created.id })
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
          displayName: 'SSH diff reload E2E'
        })
        if ('error' in added) {
          throw new Error(added.error)
        }

        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(added.repo.id)
        const worktrees = store.getState().worktreesByRepo[added.repo.id] ?? []
        const wt = worktrees.find((w) => w.path === remoteRepo) ?? worktrees[0]
        if (!wt) {
          throw new Error('remote worktree missing')
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
    {
      remoteRepo,
      sshPort: SSH_PORT,
      identityFile: keyPath,
      label: `SSH diff E2E ${Date.now()}`
    }
  )

  console.log('SSH context:', ctx)
  await sleep(2000)

  // Test A: unstaged diff loads over SSH
  await page.evaluate(({ worktreeId, worktreePath }) => {
    window.__store.getState().openDiff(worktreeId, worktreePath, 'beta.txt', 'plaintext', false)
  }, ctx)
  await sleep(2000)
  const t1 = await waitForMonacoContains(page, 'beta-v1')
  console.log(`[${t1 ? 'PASS' : 'FAIL'}] SSH unstaged diff loads`)

  // Test B: external edit on remote file via ssh
  sh(
    `ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no orca@127.0.0.1 ` +
      `"printf '%s\\n' 'beta-ssh-external-v2' > ${remoteRepo}/beta.txt"`
  )
  await sleep(2000)
  const t2 = await waitForMonacoContains(page, 'beta-ssh-external-v2')
  console.log(`[${t2 ? 'PASS' : 'FAIL'}] SSH external edit reload`)

  // Test C: combined all changes over SSH
  await page.evaluate(({ worktreeId, worktreePath }) => {
    const s = window.__store.getState()
    s.openAllDiffs(worktreeId, worktreePath)
    s.setActiveView('editor')
  }, ctx)
  await sleep(2500)
  const t3 = await waitForMonacoContains(page, 'beta-ssh-external-v2')
  console.log(`[${t3 ? 'PASS' : 'FAIL'}] SSH combined diff loads`)

  // Test D: combined external watch over SSH
  sh(
    `ssh -i "${keyPath}" -p ${SSH_PORT} -o StrictHostKeyChecking=no orca@127.0.0.1 ` +
      `"printf '%s\\n' 'beta-ssh-combined-v3' > ${remoteRepo}/beta.txt"`
  )
  await sleep(2500)
  const t4 = await waitForMonacoContains(page, 'beta-ssh-combined-v3')
  console.log(`[${t4 ? 'PASS' : 'FAIL'}] SSH combined external watch`)

  const passed = [t1, t2, t3, t4].filter(Boolean).length
  console.log(`\n=== SSH SUMMARY: ${passed}/4 passed ===`)

  sh(`docker rm -f ${CONTAINER} 2>/dev/null || true`)

  if (passed < 4) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  try {
    sh(`docker rm -f ${CONTAINER} 2>/dev/null || true`)
  } catch {
    // ignore cleanup errors
  }
  process.exit(1)
})
