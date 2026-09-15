import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ORCA_REF, ROOT, PROJECT, CONTROL, PORT, agentEnvironment } from './configuration.mjs'

export async function command(box, args) {
  const result = await box.runCommand({ cwd: ROOT, timeoutMs: 60000, ...args })
  if (result.exitCode !== 0) {
    throw new Error(
      `Remote ${args.cmd} failed (exit ${result.exitCode}); inspect Sandbox command logs`
    )
  }
  return result
}
export async function upload(box, filename) {
  const path = `${CONTROL}/${filename}`
  await box.writeFiles([
    { path, content: readFileSync(new URL(filename, import.meta.url)), mode: 0o700 }
  ])
  return path
}
export async function initializeProject(box, config, owner) {
  await command(box, { cmd: 'mkdir', args: ['-p', box.cwd, CONTROL], cwd: '/' })
  const runtime = await box.readFileToBuffer({ path: `${CONTROL}/runtime-ref` })
  if (runtime?.toString() !== ORCA_REF) {
    throw new Error('Build a base at the pinned Orca commit first')
  }
  const script = await upload(box, 'remote-project.sh')
  await command(box, {
    cmd: 'bash',
    args: [script],
    env: {
      ORCA_REPO_URL: config.repoUrl,
      ORCA_REPO_REF: config.repoRef,
      ORCA_WORKSPACE_OWNER: owner
    }
  })
}
export async function serve(box, owner) {
  const ownership = await box.readFileToBuffer({ path: `${CONTROL}/owner` })
  if (ownership?.toString() !== owner) {
    throw new Error('Recovery owner marker missing or mismatched; refusing fresh initialization')
  }
  await command(box, { cmd: 'git', args: ['-C', PROJECT, 'rev-parse', '--git-dir'] })
  const script = await upload(box, 'remote-serve.sh')
  const sessionId = box.currentSession().sessionId
  const existing = await readyRecipe(box, sessionId)
  if (existing) {
    return existing
  }
  // Recipe mode detaches Electron; the launcher PID is not the server's lifetime.
  const launcher = await box.runCommand({
    cmd: 'bash',
    args: [script],
    cwd: ROOT,
    detached: true,
    env: {
      ...agentEnvironment(),
      ORCA_VERCEL_SESSION: sessionId,
      ORCA_PUBLIC_WSS: box.domain(PORT).replace(/^https:/, 'wss:')
    }
  })
  const controller = new AbortController()
  let finished
  let waitError
  const completion = launcher.wait({ signal: controller.signal }).then(
    (result) => {
      finished = result
    },
    (error) => {
      if (!controller.signal.aborted) {
        waitError = error
      }
    }
  )
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const recipe = await readyRecipe(box, sessionId)
      if (recipe) {
        return recipe
      }
      if (waitError) {
        throw waitError
      }
      if (finished && finished.exitCode !== 0) {
        const error = new Error(`Orca launcher exited with code ${finished.exitCode}`)
        error.startupDiagnostics = sanitizeDiagnostics(await finished.stderr())
        throw error
      }
      await delay(500)
    }
    throw new Error('Orca startup timed out; inspect /vercel/orca-control/server.log')
  } finally {
    controller.abort()
    await completion
  }
}

async function readyRecipe(box, sessionId) {
  const probe = await box.runCommand({
    cmd: 'node',
    args: [
      '-e',
      `
    const fs = require('node:fs');
    if (fs.readFileSync('/vercel/orca-control/session-id', 'utf8') !== process.env.ORCA_VERCEL_SESSION) process.exit(1);
    const ready = JSON.parse(fs.readFileSync('/vercel/orca-control/ready.json', 'utf8'));
    const socket = require('node:net').connect(6768, '127.0.0.1');
    socket.setTimeout(1500);
    socket.on('error', () => process.exit(1));
    socket.on('timeout', () => process.exit(1));
    socket.on('connect', () => { console.log(JSON.stringify(ready)); socket.end(); });
  `
    ],
    cwd: ROOT,
    timeoutMs: 5000,
    env: { ORCA_VERCEL_SESSION: sessionId }
  })
  if (probe.exitCode !== 0) {
    return null
  }
  try {
    const recipe = JSON.parse(await probe.output())
    return typeof recipe.pairingCode === 'string' && recipe.projectRoot === PROJECT ? recipe : null
  } catch {
    return null
  }
}

export async function startupDiagnostics(box) {
  try {
    const log = await box.readFileToBuffer({ path: `${CONTROL}/server.log` })
    return sanitizeDiagnostics(log?.toString() ?? 'No server log was written')
  } catch {
    return 'Diagnostic collection failed; original startup error retained'
  }
}

export function sanitizeDiagnostics(value) {
  let text = value.slice(-16000)
  for (const secret of Object.values(agentEnvironment())) {
    if (secret) {
      text = text.replaceAll(secret, '[REDACTED]')
    }
  }
  return text
    .replace(/orca:[^\s]+/g, '[REDACTED_PAIRING]')
    .replace(/[A-Za-z0-9_-]{160,}/g, '[REDACTED_LONG_VALUE]')
}
