import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// Bare-ID writes can edit the wrong local/SSH twin; require RepoHostTarget/HostWorktreeTarget and allow counts only to decrease.
// Match parameter names regardless of types; known limit: IDs inside object parameters are not detected.

const BASELINE_PATH = 'config/id-only-store-write-baseline.txt'
const COMPOSITION = 'src/main/persistence/loading-store/store-domain-composition.ts'
// The only type names that make an id-named parameter host-carrying.
const HOST_TARGET_TYPE = /^(?:RepoHostTarget|HostWorktreeTarget)\b/
const ID_PARAM = /^(?:id|ids|\w*Ids?|(?:\w*(?:Worktree|Workspace)|worktree|workspace)Keys?)$/
const READ_METHOD = /^(?:get|list|has|peek|read|is|select|find|automation)[A-Z]/
// A public method or arrow property with its first parameter's name and type. `private`,
// `protected` and `#` members don't match: they aren't on the Store's surface.
const MEMBER =
  /^ {2}(?:(?:public|override|static|async|readonly)\s+)*(\w+)\s*(?:<[^>\n]*>)?(?:\s*=\s*(?:async\s*)?(?:<[^>\n]*>)?)?\(\s*(\w+)\??\s*:\s*([^,)=]+)/gm

/** `Class.param` first parameters whose id has no host twin, with the reason. */
export const NOT_HOST_TWINNED_PARAMS = new Map([
  ['AutomationPersistence.automationId', 'automation ids are minted UUIDs'],
  ['OrcadSourceExportPersistence.targetId', 'the id names the host itself'],
  ['RemoteLayoutSnapshotPersistence.environmentId', 'the id names the host itself'],
  ['SessionHostPartitionOperations.hostId', 'the id names the host itself'],
  ['SshLeaseRecoveryOperations.targetId', 'the id names the host itself'],
  ['SshProfileOperations.oldTargetId', 'the id names the host itself']
])

// The store keeps one row per id: minted UUIDs, de-duplicated on load, and a conflicting
// migration import is refused (orcad-catalog-row-identity.ts `selectNewRows`).
const UNIQUE_GROUP_ID = 'group ids are minted UUIDs, one row per id in the store'
const UNIQUE_FOLDER_ID = 'folder workspace ids are minted UUIDs, one row per id in the store'

/** Matches exempt by method, with the reason. Keep each reason true. */
export const NOT_HOST_TWINNED = new Map([
  ['AutomationPersistence.advanceAutomationNextRun', 'automation ids are minted UUIDs'],
  ['AutomationPersistence.deleteAutomation', 'automation ids are minted UUIDs'],
  ['AutomationPersistence.updateAutomation', 'automation ids are minted UUIDs'],
  [
    'MetadataLineageOperations.removeUnhostedWorktreeMeta',
    'acts only on a row no host stamped; it refuses a stamped one'
  ],
  [
    'OrcadMigrationBlobInstallPersistence.installDeferredOrcadMigrationShellHistory',
    'a retry trigger: the id only gates a store-wide reinstall; nothing is written under it'
  ],
  ['ProfilePreferences.recordFeatureInteraction', 'a feature id, not a row'],
  ['ProjectCollectionOperations.deleteProjectGroup', UNIQUE_GROUP_ID],
  ['ProjectCollectionOperations.removeFolderWorkspace', UNIQUE_FOLDER_ID],
  ['ProjectCollectionOperations.updateFolderWorkspace', UNIQUE_FOLDER_ID],
  ['ProjectCollectionOperations.updateProject', 'one Project row spans every host'],
  ['ProjectCollectionOperations.updateProjectGroup', UNIQUE_GROUP_ID],
  [
    'RepoLifecycleOperations.reorderRepos',
    'a whole-catalog permutation: a duplicated id fails its check, so it refuses instead of guessing'
  ],
  ['RepoLifecycleOperations.reorderReposForHost', 'its second parameter scopes it to one host'],
  [
    'RetiredWorktreeNamePersistence.addRetiredWorktreeName',
    'twins share one id-keyed bucket by design; re-keying it is a non-goal (D7)'
  ],
  [
    'RetiredWorktreeNamePersistence.mergeRetiredWorktreeNames',
    'twins share one id-keyed bucket by design; re-keying it is a non-goal (D7)'
  ],
  [
    'SparsePresetPersistence.removeSparsePreset',
    'twins share one id-keyed bucket by design; re-keying it is a non-goal (D7)'
  ],
  ['SshProfileOperations.removeSshTarget', 'the id names the host itself'],
  ['SshProfileOperations.updateSshTarget', 'the id names the host itself']
])

/** `[className, file]` for every operations class the Store mixes in, in composition order. */
export function listStoreOperationClasses(root) {
  const text = fs.readFileSync(path.join(root, COMPOSITION), 'utf8')
  // Each value name a one-line import brings in (an operations class may share its import).
  const imports = new Map(
    [...text.matchAll(/^import \{ ([\w, ]+) \} from '([^']+)'/gm)].flatMap((m) =>
      m[1]
        .split(',')
        .map((name) =>
          name
            .trim()
            .split(/\s+as\s+/)
            .at(-1)
        )
        .filter(Boolean)
        .map((name) => [name, m[2]])
    )
  )
  const list = /STORE_DOMAIN_OPERATION_CLASSES = \[([\s\S]*?)\]/.exec(text)
  if (!list) {
    throw new Error(`${COMPOSITION}: STORE_DOMAIN_OPERATION_CLASSES not found`)
  }
  return list[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const specifier = imports.get(name)
      if (!specifier) {
        throw new Error(`${COMPOSITION}: no import for ${name}`)
      }
      return [name, path.posix.join(path.posix.dirname(COMPOSITION), `${specifier}.ts`)]
    })
}

/** Public mutating methods of `className` in `source` whose first parameter is a bare id string. */
export function findIdOnlyWrites(className, source) {
  const start = source.indexOf(`export class ${className}`)
  if (start === -1) {
    return []
  }
  const rest = source.slice(start)
  const end = rest.search(/^\}/m)
  const body = end < 0 ? rest : rest.slice(0, end)
  const found = []
  for (const [, method, param, type] of body.matchAll(MEMBER)) {
    if (
      method !== 'constructor' &&
      !READ_METHOD.test(method) &&
      ID_PARAM.test(param) &&
      !NOT_HOST_TWINNED_PARAMS.has(`${className}.${param}`) &&
      !HOST_TARGET_TYPE.test(type.trim())
    ) {
      found.push(`${className}.${method}`)
    }
  }
  return found
}

// ID-only row lookups can misroute writes even when mutator takes a row (#review-5: SSH setup renamed local twin).
const LOOKUP_ROOT = 'src/main/persistence/'
const REPO_ROW_LOOKUP = /\brepos\s*\??\.\s*(?:find|findIndex|findLast|findLastIndex)\s*\(/g
// A predicate that names a host (or compares whole rows' host ids) is host-scoped.
const HOST_SCOPED_PREDICATE = /host|Host|connectionId/
const ID_COMPARISON = /\bid\s*===|===\s*(?:[\w.]*\.)?id\b/
const DECLARATION =
  /^[ \t]*(?:export\s+)?(?:(?:async|public|private|protected|static|override|readonly)\s+)*(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=\n]*)?=>|(\w+)\s*(?:<[^>\n]*>)?\s*\([^)]*\)\s*(?::[^{;\n]*)?\{)/gm
const NOT_A_DECLARATION = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'function'])

/** The text from an opening paren to its match, so a multi-line predicate is read whole. */
function balancedArgs(source, openIndex) {
  let depth = 0
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '(') {
      depth++
    } else if (source[i] === ')' && --depth === 0) {
      return source.slice(openIndex, i + 1)
    }
  }
  return source.slice(openIndex)
}

function enclosingDeclaration(source, index) {
  let name = '<module>'
  for (const match of source.slice(0, index).matchAll(DECLARATION)) {
    const candidate = match[1] ?? match[2] ?? match[3]
    if (candidate && !NOT_A_DECLARATION.has(candidate)) {
      name = candidate
    }
  }
  return name
}

/** `file#function` for every repo-row lookup in `source` whose predicate matches by id alone. */
export function findIdOnlyLookups(rel, source) {
  const found = []
  for (const match of source.matchAll(REPO_ROW_LOOKUP)) {
    const predicate = balancedArgs(source, match.index + match[0].length - 1)
    if (ID_COMPARISON.test(predicate) && !HOST_SCOPED_PREDICATE.test(predicate)) {
      found.push(`lookup:${rel}#${enclosingDeclaration(source, match.index)}`)
    }
  }
  return found
}

function collectIdOnlyLookups(root) {
  const sources = readTrackedSources(
    root,
    [LOOKUP_ROOT],
    (rel) => rel.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(rel)
  )
  return [...sources].flatMap(([rel, source]) => findIdOnlyLookups(rel, source))
}

export function collectIdOnlyStoreWrites(root = process.cwd()) {
  const entries = []
  for (const [className, rel] of listStoreOperationClasses(root)) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8')
    entries.push(...findIdOnlyWrites(className, source).filter((e) => !NOT_HOST_TWINNED.has(e)))
  }
  entries.push(...collectIdOnlyLookups(root))
  return [...new Set(entries)].sort()
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(
    {
      name: 'id-only-store-write',
      baselinePath: BASELINE_PATH,
      header: [
        '# Store writes whose first parameter is a bare repo or worktree id (R4-2), as Class.method,',
        '# and persistence repo-row lookups by id alone (review-5 #10), as lookup:file#function.',
        '# This is a RATCHET: entries may only be REMOVED. Take RepoHostTarget or HostWorktreeTarget,',
        '# or match the row by id AND host (getRepoExecutionHostId).',
        '# Prune after a fix: pnpm check:id-only-store-write-ratchet --prune'
      ],
      collect: collectIdOnlyStoreWrites,
      fix: [
        'Take the row, not its id: RepoHostTarget (src/shared/repo-host-identity.ts) for repo rows,',
        'HostWorktreeTarget (src/shared/worktree/host-qualified-identity.ts) for worktree rows. A caller',
        'with only an id resolves the row where its host is known (RPC selector, IPC hostId).'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
