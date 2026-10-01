export function getStatusPluginRuntimeStateSource(): string[] {
  return [
    'const HOOK_POST_TIMEOUT_MS = 2000;',
    'const SESSION_LOOKUP_TIMEOUT_MS = 2000;',
    'const MAX_SESSION_ANCESTRY_DEPTH = 32;',
    'const STATUS_RETRY_BASE_MS = 500;',
    'const STATUS_RETRY_MAX_MS = 30000;',
    'let desiredStatus = "idle";',
    'let desiredHookEventName = "SessionIdle";',
    'let desiredStatusKey = "idle:";',
    'let desiredStatusProperties = {};',
    'let desiredFactoryID = null;',
    'let deliveredStatusKey = "idle:";',
    'let deliveredEndpointKey = "";',
    'let statusDeliveryDirty = false;',
    'let statusRevision = 0;',
    'let statusRetryAttempt = 0;',
    'let statusRetryTimer = null;',
    'let lifecycleQueue = Promise.resolve();',
    'let busyRecoveryQueued = false;',
    'let busyRecoveryUsed = false;',
    'let busyRecoveryEndpointKey = "";',
    'let stateArrivalRevision = 0;',
    '// Why: only OpenCode 2 calls setup(); its posts tell the host to keep its OpenCode 1 binder off them.',
    'let reportingOpenCodeMajor = 0;',
    '// Why: OpenCode can create directory-scoped factories and concurrent root',
    '// sessions in one pane; module ownership lets waiting/busy aggregate safely.',
    'let nextFactoryID = 0;',
    'const activeFactoryIDs = new Set();',
    'const disposingFactoryIDs = new Set();',
    'const busyRootOwnerBySessionID = new Map();',
    '// Why: a matching Idle must retire fail-open Busy even when the SDK client',
    '// is unavailable, without granting an unrelated unknown Idle authority.',
    'const provisionalBusyByKey = new Map();',
    '// Why: a background child outlives the root turn that spawned it, so the',
    '// pane must stay Busy on its behalf until its own exact Idle (or its',
    "// factory's disposal) retires it — otherwise the root Idle completes a task",
    '// tree that is still working.',
    'const busyChildRootByKey = new Map();',
    'const pendingAttentionByKey = new Map();',
    'const rootSessionById = new Map();',
    'const rootSessionLookupById = new Map();',
    '',
    '// Why: message.part.updated re-sends the FULL accumulated text of the part',
    '// after every streamed append, so posting each event forwards O(n^2) bytes',
    '// per turn through Orca (loopback HTTP -> main JSON parse -> status compare',
    '// -> IPC -> renderer store update -> React commit). On Windows that flood',
    '// saturated both event loops and froze the whole UI a few seconds into a',
    '// streaming reply. The dashboard only needs a bounded preview at a human',
    '// cadence: cap the text and trailing-edge coalesce assistant parts.',
    'const MESSAGE_PART_THROTTLE_MS = 250;',
    'const MESSAGE_PART_MAX_CHARS = 4000;',
    'let pendingAssistantPart = null;',
    'let assistantPartFlushTimer = null;',
    'let messagePartPostInFlight = null;',
    'let deliveredMessagePartFactoryID = null;',
    'let lastAssistantPartPostAt = 0;',
    ...getRunProcessSource()
  ]
}

// Mirrors isOpenCodeRunCommand (src/shared/opencode-headless-command.ts) over this process's argv.
function getRunProcessSource(): string[] {
  return String.raw`
function isOpenCodeRunProcess() {
  // Why drop a leading path: a compiled binary reports its embedded entry script as argv[1].
  const args = process.argv.slice(1);
  if (args.length > 0 && /[\\/]/.test(args[0])) args.shift();
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("-")) return args[index] === "run";
    if (args[index] === "--log-level") index += 1;
  }
  return false;
}`.split('\n')
}
