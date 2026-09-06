// Load mock registration before importing bindings that are mocked by setup.spec.ts.
import './setup.spec'

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { RuntimeBrowserCommands } from '../orca-runtime-browser'
import {
  setRuntimeBrowserCommandsFactory,
  setRuntimeBrowserUnavailableCause
} from '../runtime-browser-commands-factory'
import { setRuntimeTerminalUnavailableCause } from '../native-terminal-availability'
import { setRuntimeDesktopSurface } from '../runtime-desktop-surface'
import { installFakeAppEnvironment } from '../../../../config/scripts/vitest-host-ports-setup'
import { performance } from 'node:perf_hooks'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { ipcMain } from 'electron'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import {
  reviewHeadRemoteRefComponent,
  REVIEW_HEAD_FETCH_TIMEOUT_MS
} from '../../../shared/review-head-tracking-ref'
import { detectAgentStatusFromTitle, MAX_OSC_TITLE_CHARS } from '../../../shared/agent-detection'
import {
  addSparseWorktree,
  addWorktree,
  assertWorktreeCleanForRemoval,
  describeCreatedWorktree,
  listWorktrees,
  listWorktreesSharedStrict,
  listWorktreesStrict,
  removeWorktree
} from '../../git/worktree'
import * as gitRunner from '../../git/runner'
import {
  WORKTREE_PROCESS_SWEEP_TIMEOUT_MS,
  WORKTREE_TEARDOWN_RPC_MARGIN_MS
} from '../worktree-teardown'
import { clearSubmodulePathsCacheForTests, listSubmodulePaths } from '../../git/status'
import { getEffectiveHooks, hasHooksFile, loadHooks, parseOrcaYaml, runHook } from '../../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../../worktree-runner-script'
import {
  getEffectiveHooksFromConfig,
  getDefaultTabsLaunch,
  shouldRunSetupForCreate
} from '../../effective-hook-config'
import { getBaseRefDefault, getBranchConflictKind } from '../../git/repo'
import { OrchestrationDb as RuntimeOrchestrationDb } from '../orchestration/db'
import {
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
  appendNormalizedToTailBuffer,
  buildPreview,
  OrcaRuntimeService as OrcaRuntimeServiceConstructor,
  resolveWorktreeScanCacheTtlMs
} from '../orca-runtime'
import { RUNTIME_GRAPH_RELOAD_TIMEOUT_MS } from '../runtime-graph-reload-lifecycle'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from '../browser-host-lease-registry-instance'
import {
  appendRecentPtyPathCandidates,
  recentTerminalPathCandidatesIncludePath,
  recentTerminalOutputIncludesPath
} from '../terminal-output-path-candidates'
import { RecentPtyOutputBuffer } from '../recent-pty-output-buffer'
import { headlessBrowserTabsUnchanged } from '../mobile-session-browser-equality'
import {
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from '../mobile-session-browser-group-projection'
import { HeadlessEmulator } from '../../daemon/headless-emulator'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import {
  TERMINAL_INPUT_CHUNK_MAX_BYTES,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR
} from '../../../shared/terminal-input'
import { MAX_QUICK_COMMANDS } from '../../../shared/terminal-quick-commands'
import {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs,
  getTerminalPasteIngestMs
} from '../../../shared/agent-prompt-injection'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../../shared/clipboard-text'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../../providers/ssh-git-dispatch'
import {
  registerPty as registerLocalPtyMemoryRow,
  unregisterPty as unregisterLocalPtyMemoryRow
} from '../../memory/pty-registry'
import { inspectPtyProviderProcess } from '../../providers/pty-process-inspection'
import * as worktreePathComparison from '../../ipc/worktree-path-comparison'
import * as localWorktreeFilesystem from '../../local-worktree-filesystem'
import {
  DEFAULT_REPO_BADGE_COLOR,
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession
} from '../../../shared/constants'
import { advertisedUrlWatcher } from '../../ports/advertised-url-watcher'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../shared/setup-agent-sequencing'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { RpcDispatcher } from '../rpc/dispatcher'
import { TERMINAL_METHODS } from '../rpc/methods/terminal'
import { beginWatcherInstall } from '../../ipc/watcher-removal-gate'
import { WATCHER_REMOVAL_DRAIN_BUDGET_MS } from '../../ipc/watcher-removal-drain'
import {
  _resetTerminalViewAttributesForTest,
  setTerminalViewAttributes
} from '../terminal-view-attribute-store'
import { clearConfiguredWorktreeSharedDirectoriesCacheForTests } from '../../git/worktree-shared-directories'
import { setWorktreeWatcherRemoval } from '../../ipc/worktree-watcher-removal'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'

// Imported bindings are copied after Vitest's hoisted mocks have registered.
export const exportedAGENT_PROMPT_BRACKETED_PASTE_END = AGENT_PROMPT_BRACKETED_PASTE_END
export const exportedAGENT_PROMPT_BRACKETED_PASTE_START = AGENT_PROMPT_BRACKETED_PASTE_START
export const exportedAGENT_STATUS_STALE_AFTER_MS = AGENT_STATUS_STALE_AFTER_MS
export const exportedAUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS =
  AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS
export const exportedCLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS =
  CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS
export const exportedDEFAULT_REPO_BADGE_COLOR = DEFAULT_REPO_BADGE_COLOR
export const exportedEventEmitter = NodeEventEmitter
export const exportedFLOATING_TERMINAL_WORKTREE_ID = FLOATING_TERMINAL_WORKTREE_ID
export const exportedFOLDER_WORKSPACE_INSTANCE_SEPARATOR = FOLDER_WORKSPACE_INSTANCE_SEPARATOR
export const exportedHEADLESS_RUNTIME_WINDOW_ID = HEADLESS_RUNTIME_WINDOW_ID
export const exportedHeadlessEmulator = HeadlessEmulator
export const exportedMAX_OSC_TITLE_CHARS = MAX_OSC_TITLE_CHARS
export const exportedMAX_QUICK_COMMANDS = MAX_QUICK_COMMANDS
export const exportedOrcaRuntimeService = OrcaRuntimeServiceConstructor
export const exportedOrchestrationDb = RuntimeOrchestrationDb
export const exportedREVIEW_HEAD_FETCH_TIMEOUT_MS = REVIEW_HEAD_FETCH_TIMEOUT_MS
export const exportedRUNTIME_GRAPH_RELOAD_TIMEOUT_MS = RUNTIME_GRAPH_RELOAD_TIMEOUT_MS
export const exportedRecentPtyOutputBuffer = RecentPtyOutputBuffer
export const exportedRpcDispatcher = RpcDispatcher
export const exportedRuntimeBrowserCommands = RuntimeBrowserCommands
export const exportedSETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV =
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV
export const exportedSETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV =
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
export const exportedTERMINAL_INPUT_CHUNK_MAX_BYTES = TERMINAL_INPUT_CHUNK_MAX_BYTES
export const exportedTERMINAL_INPUT_MAX_BYTES = TERMINAL_INPUT_MAX_BYTES
export const exportedTERMINAL_INPUT_TOO_LARGE_ERROR = TERMINAL_INPUT_TOO_LARGE_ERROR
export const exportedTERMINAL_METHODS = TERMINAL_METHODS
export const exportedTUI_AGENT_CONFIG = TUI_AGENT_CONFIG
export const exportedWATCHER_REMOVAL_DRAIN_BUDGET_MS = WATCHER_REMOVAL_DRAIN_BUDGET_MS
export const exportedWORKTREE_PROCESS_SWEEP_TIMEOUT_MS = WORKTREE_PROCESS_SWEEP_TIMEOUT_MS
export const exportedWORKTREE_TEARDOWN_RPC_MARGIN_MS = WORKTREE_TEARDOWN_RPC_MARGIN_MS
export const exportedPrivateresetTerminalViewAttributesForTest = _resetTerminalViewAttributesForTest
export const exportedAddSparseWorktree = addSparseWorktree
export const exportedAddWorktree = addWorktree
export const exportedAdvertisedUrlWatcher = advertisedUrlWatcher
export const exportedAfterEach = afterEach
export const exportedAppendBrowserTabOrder = appendBrowserTabOrder
export const exportedAppendNormalizedToTailBuffer = appendNormalizedToTailBuffer
export const exportedAppendRecentPtyPathCandidates = appendRecentPtyPathCandidates
export const exportedAssertWorktreeCleanForRemoval = assertWorktreeCleanForRemoval
export const exportedBasename = basename
export const exportedBeforeEach = beforeEach
export const exportedBeginWatcherInstall = beginWatcherInstall
export const exportedBuildAgentPromptPasteBytes = buildAgentPromptPasteBytes
export const exportedBuildPreview = buildPreview
export const exportedClearConfiguredWorktreeSharedDirectoriesCacheForTests =
  clearConfiguredWorktreeSharedDirectoriesCacheForTests
export const exportedClearSubmodulePathsCacheForTests = clearSubmodulePathsCacheForTests
export const exportedCollectBrowserGroupAssignment = collectBrowserGroupAssignment
export const exportedCreateHash = createHash
export const exportedCreateRootDispatch = createRootDispatch
export const exportedCreateSetupRunnerScript = createSetupRunnerScript
export const exportedDescribe = describe
export const exportedDescribeCreatedWorktree = describeCreatedWorktree
export const exportedDetectAgentStatusFromTitle = detectAgentStatusFromTitle
export const exportedExecFileSync = execFileSync
export const exportedExpect = expect
export const exportedGetAgentPromptSubmitDelayMs = getAgentPromptSubmitDelayMs
export const exportedGetBaseRefDefault = getBaseRefDefault
export const exportedGetBranchConflictKind = getBranchConflictKind
export const exportedGetBrowserHostLeaseRegistry = getBrowserHostLeaseRegistry
export const exportedGetDefaultTabsLaunch = getDefaultTabsLaunch
export const exportedGetDefaultWorkspaceSession = getDefaultWorkspaceSession
export const exportedGetEffectiveHooks = getEffectiveHooks
export const exportedGetEffectiveHooksFromConfig = getEffectiveHooksFromConfig
export const exportedGetRuntimeBrowserPageRegistry = getRuntimeBrowserPageRegistry
export const exportedGetTerminalPasteIngestMs = getTerminalPasteIngestMs
export const exportedGitRunner = gitRunner
export const exportedHasHooksFile = hasHooksFile
export const exportedHeadlessBrowserTabsUnchanged = headlessBrowserTabsUnchanged
export const exportedHomedir = homedir
export const exportedInspectPtyProviderProcess = inspectPtyProviderProcess
export const exportedInstallFakeAppEnvironment = installFakeAppEnvironment
export const exportedIpcMain = ipcMain
export const exportedIt = it
export const exportedJoin = join
export const exportedListSubmodulePaths = listSubmodulePaths
export const exportedListWorktrees = listWorktrees
export const exportedListWorktreesSharedStrict = listWorktreesSharedStrict
export const exportedListWorktreesStrict = listWorktreesStrict
export const exportedLoadHooks = loadHooks
export const exportedLocalWorktreeFilesystem = localWorktreeFilesystem
export const exportedLstat = lstat
export const exportedMakePaneKey = makePaneKey
export const exportedMkdir = mkdir
export const exportedMkdirSync = mkdirSync
export const exportedMkdtemp = mkdtemp
export const exportedOnTestFinished = onTestFinished
export const exportedParseOrcaYaml = parseOrcaYaml
export const exportedPerformance = performance
export const exportedProjectHostSetupProjectionFromRepos = projectHostSetupProjectionFromRepos
export const exportedRandomUUID = randomUUID
export const exportedRecentTerminalOutputIncludesPath = recentTerminalOutputIncludesPath
export const exportedRecentTerminalPathCandidatesIncludePath =
  recentTerminalPathCandidatesIncludePath
export const exportedRegisterLocalPtyMemoryRow = registerLocalPtyMemoryRow
export const exportedRegisterSshFilesystemProvider = registerSshFilesystemProvider
export const exportedRegisterSshGitProvider = registerSshGitProvider
export const exportedRemoveWorktree = removeWorktree
export const exportedResolveSetupRunnerShell = resolveSetupRunnerShell
export const exportedResolveWorktreeScanCacheTtlMs = resolveWorktreeScanCacheTtlMs
export const exportedReviewHeadRemoteRefComponent = reviewHeadRemoteRefComponent
export const exportedRm = rm
export const exportedRunHook = runHook
export const exportedSetRuntimeBrowserCommandsFactory = setRuntimeBrowserCommandsFactory
export const exportedSetRuntimeBrowserUnavailableCause = setRuntimeBrowserUnavailableCause
export const exportedSetRuntimeDesktopSurface = setRuntimeDesktopSurface
export const exportedSetRuntimeTerminalUnavailableCause = setRuntimeTerminalUnavailableCause
export const exportedSetTerminalViewAttributes = setTerminalViewAttributes
export const exportedSetWorktreeWatcherRemoval = setWorktreeWatcherRemoval
export const exportedShouldRunSetupForCreate = shouldRunSetupForCreate
export const exportedTmpdir = tmpdir
export const exportedUnregisterLocalPtyMemoryRow = unregisterLocalPtyMemoryRow
export const exportedUnregisterSshFilesystemProvider = unregisterSshFilesystemProvider
export const exportedUnregisterSshGitProvider = unregisterSshGitProvider
export const exportedVi = vi
export const exportedWin32 = win32
export const exportedWorktreePathComparison = worktreePathComparison
export const exportedWriteFile = writeFile
