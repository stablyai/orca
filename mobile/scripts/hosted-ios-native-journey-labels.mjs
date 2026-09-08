import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { EMULATOR_AGENT_HISTORY_TITLE } from './emulator-agent-history-fixture.mjs'
import { dismissEmulatorDeveloperMenuIfPresent } from './emulator-developer-menu-dismissal.mjs'
import {
  readHostedIosAccessibilityLabels,
  rotateHostedIosEmulator,
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlByLabelPrefix,
  tapHostedIosPoint,
  typeHostedIosText,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityControlEndingWith,
  waitForHostedIosAccessibilityControlMatching,
  waitForHostedIosAccessibilityLabel
} from './hosted-ios-emulator-accessibility.mjs'
import { longPressHostedIosAccessibilityControlByLabelPrefix } from './hosted-ios-emulator-long-press.mjs'

const execFileAsync = promisify(execFile)
const ACCOUNTS_STABLE_TEXT = 'Add or re-authenticate accounts from desktop Settings → Accounts.'
const ACCOUNTS_TOOLBAR_X = 0.8
const TASKS_TOOLBAR_X = 0.87
const AGENT_HISTORY_SEARCH_PLACEHOLDER = 'Search sessions, repo:, path:'
const AGENT_HISTORY_SEARCH_QUERY = 'hybrid agent history fixture'
const CHANGED_FILE_LABEL_PREFIX = 'Open changed file '
const FILES_STABLE_LABEL = 'Open folder Casks'
const PREVIEW_FILE_LABEL = 'Preview file orca.rb'
const PREVIEW_STABLE_LABEL = 'File preview'
const SETTLE_INTERVAL_MS = 900
const SETTLE_TIMEOUT_MS = 20_000
const VOLATILE_LABEL =
  /^(\d{1,2}:\d{2}\s?(AM|PM)|Dynamic Island.*|Cellular|SSID.*|\d+% battery power|Not charging|Charging|No signal|\d of \d Wi-Fi bars)$/

// Why: the six native journeys the hosted e2e baselines drive, captured as ordered
// accessibility labels plus a screenshot so two client builds can be diffed.
export async function captureHostedIosNativeJourneyLabels(args) {
  const stops = []
  const capture = async (name) => {
    stops.push({ name, ...(await captureStop(args, name)) })
  }
  await dismissEmulatorDeveloperMenuIfPresent(args.emulator)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
  await capture('workspaces')
  await walkAccounts(args, capture)
  await walkTasks(args, capture)
  await walkSessionAndFiles(args, capture)
  await walkSourceControl(args, capture)
  await walkAgentHistory(args, capture)
  return stops
}

async function walkAccounts(args, capture) {
  const filterPoint = await waitForHostedIosAccessibilityControl(
    args.emulator,
    'Filter',
    args.timeoutMs
  )
  await tapHostedIosPoint(args.emulator, { x: ACCOUNTS_TOOLBAR_X, y: filterPoint.y })
  const title = await waitForHostedIosAccessibilityControl(
    args.emulator,
    'Accounts',
    args.timeoutMs
  )
  await waitForHostedIosAccessibilityControl(args.emulator, ACCOUNTS_STABLE_TEXT, args.timeoutMs)
  await capture('accounts')
  await tapHostedIosPoint(args.emulator, { x: 0.075, y: title.y })
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
}

async function walkTasks(args, capture) {
  const filterPoint = await waitForHostedIosAccessibilityControl(
    args.emulator,
    'Filter',
    args.timeoutMs
  )
  await tapHostedIosPoint(args.emulator, { x: TASKS_TOOLBAR_X, y: filterPoint.y })
  const title = await waitForHostedIosAccessibilityControl(args.emulator, 'Tasks', args.timeoutMs)
  await capture('tasks')
  await tapHostedIosPoint(args.emulator, { x: 0.075, y: title.y })
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
}

async function walkSessionAndFiles(args, capture) {
  await tapHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    'Mobile Emulator',
    args.timeoutMs
  )
  await capture('session')
  await tapHostedIosAccessibilityControl(args.emulator, 'Open file explorer', args.timeoutMs)
  await waitForHostedIosAccessibilityControl(args.emulator, FILES_STABLE_LABEL, args.timeoutMs)
  await capture('files')
  await tapHostedIosAccessibilityControl(args.emulator, FILES_STABLE_LABEL, args.timeoutMs)
  await tapHostedIosAccessibilityControl(args.emulator, PREVIEW_FILE_LABEL, args.timeoutMs)
  await waitForHostedIosAccessibilityLabel(args.emulator, PREVIEW_STABLE_LABEL, args.timeoutMs)
  await capture('file-preview')
  await tapHostedIosAccessibilityControl(args.emulator, 'Back to files', args.timeoutMs)
  await waitForHostedIosAccessibilityControl(args.emulator, FILES_STABLE_LABEL, args.timeoutMs)
  await tapHostedIosAccessibilityControl(args.emulator, 'Back to session', args.timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    'Mobile Emulator',
    args.timeoutMs
  )
  await tapHostedIosAccessibilityControl(args.emulator, 'Back to worktrees', args.timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
}

async function walkSourceControl(args, capture) {
  await longPressHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs,
    undefined,
    'Source Control'
  )
  await capture('workspace-actions')
  await tapHostedIosAccessibilityControl(args.emulator, 'Source Control', args.timeoutMs)
  const changedFile = await waitForHostedIosAccessibilityControlMatching(
    args.emulator,
    (node) =>
      node.label?.startsWith(CHANGED_FILE_LABEL_PREFIX) ||
      node.value?.startsWith(CHANGED_FILE_LABEL_PREFIX),
    args.timeoutMs
  )
  await waitForHostedIosAccessibilityControlEndingWith(args.emulator, ' on branch', args.timeoutMs)
  await capture('source-control')
  const changedFileLabel = [changedFile.label, changedFile.value].find((value) =>
    value?.startsWith(CHANGED_FILE_LABEL_PREFIX)
  )
  await tapHostedIosAccessibilityControl(args.emulator, changedFileLabel, args.timeoutMs)
  await waitForHostedIosAccessibilityControl(args.emulator, 'Open review actions', args.timeoutMs)
  await capture('review')
  await tapHostedIosAccessibilityControl(args.emulator, 'Back', args.timeoutMs)
  await waitForHostedIosAccessibilityControl(args.emulator, 'Source Control', args.timeoutMs)
  await tapHostedIosAccessibilityControl(args.emulator, 'Back to session', args.timeoutMs)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
}

async function walkAgentHistory(args, capture) {
  await rotateHostedIosEmulator(args.emulator, 'portrait')
  await tapHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    args.expectedWorkspace,
    args.timeoutMs
  )
  await tapHostedIosAccessibilityControl(args.emulator, 'More session actions', args.timeoutMs)
  await capture('session-actions')
  await tapHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    'Agent History',
    args.timeoutMs
  )
  await tapHostedIosAccessibilityControl(
    args.emulator,
    AGENT_HISTORY_SEARCH_PLACEHOLDER,
    args.timeoutMs
  )
  await typeHostedIosText(args.emulator, AGENT_HISTORY_SEARCH_QUERY)
  await waitForHostedIosAccessibilityControlByLabelPrefix(
    args.emulator,
    EMULATOR_AGENT_HISTORY_TITLE,
    args.timeoutMs
  )
  await capture('agent-history-search')
  await tapHostedIosAccessibilityControl(args.emulator, 'Agent Session History', args.timeoutMs)
  await capture('agent-history')
}

async function captureStop(args, name) {
  const labels = await readSettledAccessibilityLabels(args)
  const screenshot = path.join(args.outputDirectory, `${name}.png`)
  await execFileAsync('xcrun', ['simctl', 'io', args.deviceUdid, 'screenshot', screenshot])
  return { labels, screenshot }
}

// Why: a screen still loading its rows, or a WebView still swapping its
// accessibility subtree, reads as a client difference. Only a tree that repeats
// itself is evidence.
async function readSettledAccessibilityLabels(args) {
  const deadline = Date.now() + Math.min(args.timeoutMs, SETTLE_TIMEOUT_MS)
  let previous = null
  while (Date.now() < deadline) {
    await delay(SETTLE_INTERVAL_MS)
    const labels = await readHostedIosAccessibilityLabels(args.emulator)
    const comparable = volatileFreeLabels(labels).join('\u0000')
    if (previous !== null && previous === comparable) {
      return labels
    }
    previous = comparable
  }
  return readHostedIosAccessibilityLabels(args.emulator)
}

function volatileFreeLabels(labels) {
  return labels.filter((label) => !VOLATILE_LABEL.test(label))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
