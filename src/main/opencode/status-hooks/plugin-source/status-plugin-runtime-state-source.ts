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
    'let reportingOpenCodeMajor = 0;',
    'let reportingOpenCodeTui = false;',
    '// Module ownership aggregates concurrent root sessions and directory-scoped factories in one pane.',
    'let nextFactoryID = 0;',
    'const activeFactoryIDs = new Set();',
    'const disposingFactoryIDs = new Set();',
    'const busyRootOwnerBySessionID = new Map();',
    '// Only matching provisional Idle may retire fail-open Busy without SDK ancestry.',
    'const provisionalBusyByKey = new Map();',
    '// Background children outlive root turns; retain Busy until exact child Idle/factory disposal.',
    'const busyChildRootByKey = new Map();',
    'const pendingAttentionByKey = new Map();',
    'const rootSessionById = new Map();',
    'const rootSessionLookupById = new Map();',
    '',
    '// Full accumulated replies per delta cause quadratic traffic; cap and coalesce assistant previews.',
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
function isOpenCodeCommandProcess(command) {
  // Compiled binaries put their embedded entry-script path at argv[1].
  const args = process.argv.slice(1);
  if (args.length > 0 && /[\\/]/.test(args[0])) args.shift();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") return false;
    if (!args[index].startsWith("-")) return args[index] === command;
    if (args[index] === "--log-level") index += 1;
  }
  return false;
}
function isOpenCodeRunProcess() {
  return isOpenCodeCommandProcess("run");
}`.split('\n')
}
