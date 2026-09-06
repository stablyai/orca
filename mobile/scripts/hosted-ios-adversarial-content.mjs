import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import { HOSTED_ADVERSARIAL_CONTENT_MARKER } from './hosted-adversarial-repository-fixture.mjs'
import { stageHostedAdversarialTerminalLinks } from './hosted-adversarial-terminal-links.mjs'
import {
  captureHostedWebViewAdversarialObservation,
  hostedWebViewAdversarialContentObservations
} from './hosted-webview-adversarial-content.mjs'
import { inspectHostedWebViewAdversarialFiles } from './hosted-webview-adversarial-files.mjs'
import { readHostedWebViewTextPoint } from './hosted-webview-cdp-session.mjs'
import { tapHostedIosPoint } from './hosted-ios-emulator-accessibility.mjs'
import { registerWorktreeForPairingRuntime } from './start-emulator-pairing-runtime.mjs'

const execFileAsync = promisify(execFile)

export async function registerHostedIosAdversarialRepository(
  { fixture, orcaCli, pairingRuntimeUserDataPath, probe, timeoutMs },
  runCli = execFileAsync
) {
  const env = {
    ...process.env,
    ORCA_DEV_USER_DATA_PATH: pairingRuntimeUserDataPath,
    ORCA_USER_DATA_PATH: pairingRuntimeUserDataPath
  }
  await registerWorktreeForPairingRuntime({ env }, fixture.root, {
    logStep: () => {},
    logSuccess: () => {},
    orca: async (args, options) => {
      const result = await runCli(orcaCli, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env,
        timeout: options.timeout
      })
      return {
        stdout: String(result.stdout).trim(),
        stderr: String(result.stderr).trim()
      }
    }
  })
  return stageHostedAdversarialTerminalLinks({
    orcaCli,
    pairingRuntimeUserDataPath,
    positiveFilePath: fixture.repositoryFiles[0].filename,
    probePort: probe.port,
    probeToken: probe.token,
    timeoutMs,
    worktree: fixture.root
  })
}

export function createHostedIosAdversarialContentInspector({ emulator, fixture, timeoutMs }) {
  const observations = []
  let reviewDocument
  return {
    async inspect({ document, phase }) {
      if (phase === 'sessionDiff') {
        observations.push(
          await captureHostedIosAdversarialDiff({
            document,
            emulator,
            filename: fixture.filename,
            timeoutMs
          })
        )
        return
      }
      observations.push(
        await captureHostedWebViewAdversarialObservation({
          document,
          timeoutMs: Math.min(timeoutMs, 15_000)
        })
      )
      if (phase === 'review') {
        reviewDocument = document
      }
    },
    async evidence() {
      if (!reviewDocument) {
        throw new Error('Hosted iOS adversarial Review document is unavailable')
      }
      return {
        ...hostedWebViewAdversarialContentObservations(observations),
        ...(await inspectHostedWebViewAdversarialFiles({
          document: reviewDocument,
          fixture,
          timeoutMs
        }))
      }
    }
  }
}

async function captureHostedIosAdversarialDiff({ document, emulator, filename, timeoutMs }) {
  let lastError = new Error('Hosted iOS adversarial diff tab did not activate')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const point = await readHostedWebViewTextPoint(document, filename, undefined, {
      horizontalPosition: 0.15
    })
    await tapHostedIosPoint(emulator, point)
    await delay(250)
    try {
      return await captureHostedWebViewAdversarialObservation({
        document,
        expectedMarker: HOSTED_ADVERSARIAL_CONTENT_MARKER,
        timeoutMs: Math.min(timeoutMs, 5_000)
      })
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
