import { affectsLocalizationExtraction } from './localization-extraction-change-scope.mjs'
import { classifyPrJobs, isDocsOnlyPath } from './pr-code-change-scope.mjs'
import { listRatchetScripts } from './run-ratchets.mjs'

// Any of these can change what every check reports, so they select all of them.
const SELECT_ALL_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
const SELECT_ALL_PREFIXES = ['config/scripts/check-changed', 'config/scripts/pr-code-change-scope']

// Mirrors forceRerunTriggers in config/vitest.config.ts: one such path in a `related` run selects
// every test. That full run is CI's job; locally these paths run only their own colocated tests.
const FULL_SUITE_TRIGGER =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.[^/]+|vite\.config\.[^/]+)$|(?:^|\/)(?:config|patches)\/|^src\/packages\//
// Only module-graph files can make Vitest's `related` selection meaningful.
const IMPORTABLE = /\.(?:[cm]?[jt]sx?|json|css|scss|svg|html|wasm|ya?ml|txt|sql)$/
const UNIT_TEST_FILE = /\.test\.[cm]?[jt]sx?$/

const SOURCE_ROOTS = ['src/', 'mobile/', 'tests/', 'config/']
const TEST_FILE = /\.(?:test|spec|e2e|bench)\.[cm]?[jt]sx?$/
const LOCALES = 'src/renderer/src/i18n/'

// Ratchets default to SOURCE_ROOTS; list narrower inputs only where a scan is clearly scoped.
const RATCHET_INPUTS = {
  'check-daemon-blocking-call-ratchet.mjs': ['src/main/'],
  'check-e2e-typecheck-ratchet.mjs': ['tests/', 'config/tsconfig.e2e.json'],
  'check-focus-read-ratchet.mjs': ['src/renderer/src/', 'src/shared/'],
  'check-host-list-render-ratchet.mjs': ['src/renderer/src/'],
  'check-id-only-store-write-ratchet.mjs': ['src/main/persistence/'],
  'check-layout-writer-ratchets.mjs': ['src/main/', 'src/renderer/src/'],
  'check-main-sync-spawn-ratchet.mjs': ['src/main/'],
  'check-repo-host-read-ratchet.mjs': ['src/cli/', 'src/main/', 'src/shared/'],
  'check-runtime-electron-ratchet.mjs': ['src/main/', 'src/cli/', 'src/shared/'],
  'check-unproven-pty-retirement-ratchet.mjs': ['src/main/'],
  'check-workspace-record-read-ratchet.mjs': ['src/renderer/src/'],
  'check-worktree-id-composer-ratchet.mjs': ['src/', 'mobile/src/']
}

// The lint-only verifiers from package.json `lint`, keyed to the inputs they read. A check also
// runs when its own script changes.
export const VERIFY_CHECKS = [
  {
    name: 'rpc params catalog',
    args: ['config/scripts/generate-rpc-params-catalog.mjs', '--check'],
    inputs: ['src/main/runtime/rpc/', 'src/shared/']
  },
  {
    name: 'acp protocol',
    args: ['config/scripts/acp/generate-protocol.mjs', '--check'],
    inputs: ['src/main/acp/generated/', 'config/scripts/acp/']
  },
  {
    name: 'bundled skill guides',
    args: ['config/scripts/generate-bundled-skill-guides.mjs', '--check'],
    inputs: ['skills/', 'config/scripts/skill-stub-composition']
  },
  {
    name: 'skill bundle manifest',
    args: ['config/scripts/generate-skill-bundle-manifest.mjs'],
    inputs: ['skills/', 'resources/skills/']
  },
  {
    name: 'localization catalogs',
    runtime: 'bun',
    args: ['config/scripts/verify-localization-catalogs.mjs'],
    inputs: ['src/renderer/', 'src/shared/', LOCALES, 'config/scripts/verify-localization-catalog']
  },
  {
    name: 'localization coverage',
    runtime: 'bun',
    args: ['config/scripts/audit-localization-coverage.mjs', '--check'],
    inputs: ['src/renderer/src/', LOCALES]
  },
  {
    name: 'mobile localization',
    args: ['config/scripts/verify-mobile-localization.mjs'],
    inputs: [
      'mobile/app/',
      'mobile/src/',
      'mobile/web-entry/',
      'mobile/app.json',
      'mobile/locales/',
      'src/shared/ui-locale',
      'config/scripts/verify-mobile-localization',
      'config/scripts/verify-localization-',
      'config/scripts/generate-runtime-required-english-catalog',
      'config/scripts/localization-surfaces'
    ]
  },
  {
    name: 'mobile localization coverage',
    args: [
      'config/scripts/audit-localization-coverage.mjs',
      '--check',
      '--source-root',
      'mobile/app',
      '--source-root',
      'mobile/src',
      '--source-root',
      'mobile/web-entry',
      '--allowlist',
      'config/mobile-localization-coverage-allowlist.json'
    ],
    inputs: [
      'mobile/app/',
      'mobile/src/',
      'mobile/web-entry/',
      'config/mobile-localization-coverage-allowlist.json',
      'config/scripts/audit-localization-coverage'
    ]
  },
  {
    // CI's own predicate, so local and CI select this check identically.
    name: 'localization extraction',
    args: ['config/scripts/verify-localization-extraction.mjs'],
    matches: (files) => affectsLocalizationExtraction(files)
  },
  {
    name: 'reliability gates',
    args: ['config/scripts/check-reliability-gates.mjs'],
    inputs: ['config/reliability-gates.jsonc']
  },
  {
    name: 'node runtime pin',
    args: ['config/scripts/check-node-runtime-pin.mjs'],
    inputs: ['src/shared/node-runtime-pin', 'config/scripts/node-dist-archive-name']
  },
  {
    name: 'test file runners',
    args: ['config/scripts/check-test-file-runners.mjs'],
    inputs: [
      'config/scripts/ci-unit-files.mjs',
      'tests/playwright.config.ts',
      'mobile/vitest.config.ts'
    ],
    matches: (files) =>
      files.some((file) => TEST_FILE.test(file) || /vitest[^/]*\.config/.test(file))
  },
  {
    name: 'mobile shared dependency versions',
    args: ['config/scripts/check-mobile-shared-dependency-versions.mjs'],
    inputs: ['mobile/package.json', 'mobile/pnpm-lock.yaml']
  },
  {
    name: 'readme local links',
    args: ['config/scripts/check-readme-local-links.mjs'],
    inputs: ['README.md', 'docs/readme/']
  },
  {
    // Compiles Tailwind (~1.5s), so it runs only for inputs that can change the emitted CSS.
    name: 'compiled :has() restyle scope',
    args: ['config/scripts/check-has-restyle-scope.mjs'],
    inputs: ['electron.vite.config.ts'],
    matches: (files) =>
      files.some((file) => /^src\/(?:renderer\/.*\.(?:css|tsx?)|shared\/.*\.css)$/.test(file))
  },
  {
    name: 'import boundaries',
    runtime: 'bun',
    args: ['config/scripts/check-import-boundaries.mjs'],
    inputs: [...SOURCE_ROOTS, 'config/process-host-direct-import-baseline.txt']
  },
  {
    name: 'dead design-system classes',
    oxlint: ['--config', 'config/oxlint-dead-classes.json', 'src/renderer'],
    inputs: ['src/renderer/', 'config/oxlint-dead-classes.json']
  }
]

// Projects of run-typecheck-projects-in-parallel.mjs and the source trees whose types reach them.
const TYPECHECK_INPUTS = [
  {
    config: 'config/tsconfig.node.json',
    inputs: [
      'src/main/',
      'src/preload/',
      'src/shared/',
      'src/renderer/',
      'src/cli/',
      'src/wsl-guest/',
      'config/'
    ]
  },
  {
    config: 'config/tsconfig.tc.web.json',
    inputs: ['src/renderer/', 'src/preload/', 'src/shared/', 'src/main/']
  },
  { config: 'config/tsconfig.tc.cli.json', inputs: ['src/cli/', 'src/shared/', 'src/main/'] },
  {
    config: 'src/packages/process-host/tsconfig.test.json',
    inputs: ['src/packages/process-host/']
  }
]
const TYPECHECK_ALL_PREFIXES = ['src/packages/', 'src/types/', 'config/tsconfig', 'tsconfig.json']
// JSON reaches the type graph only through src/ imports (resolveJsonModule).
const isTypedSource = (file) =>
  /\.[cm]?tsx?$/.test(file) || (file.startsWith('src/') && file.endsWith('.json'))

function matchesPrefix(file, prefixes) {
  return prefixes.some((prefix) => file === prefix || file.startsWith(prefix))
}

// A script's stem also matches its tests and sibling modules (`verify-localization-catalog*`).
function ownScriptStem(check) {
  return check.args?.[0].replace(/\.mjs$/, '')
}

export function selectTypecheckProjects(files) {
  if (
    files.some((file) => SELECT_ALL_FILES.has(file) || matchesPrefix(file, TYPECHECK_ALL_PREFIXES))
  ) {
    return TYPECHECK_INPUTS.map(({ config }) => config)
  }
  const typed = files.filter(isTypedSource)
  return TYPECHECK_INPUTS.filter(({ inputs }) =>
    typed.some((file) => matchesPrefix(file, inputs))
  ).map(({ config }) => config)
}

// Shared analysis modules select every ratchet built on them.
const RATCHET_SHARED_MODULES = {
  'config/scripts/gated-call-use-collector.mjs': [
    'check-daemon-blocking-call-ratchet.mjs',
    'check-main-sync-spawn-ratchet.mjs'
  ]
}

function listRatchetChecks(scriptsDir) {
  const scripts = new Set(listRatchetScripts(scriptsDir))
  // `pnpm lint` runs these although CI checks them in their own steps outside run-ratchets.mjs.
  scripts.add('check-main-sync-spawn-ratchet.mjs')
  scripts.add('check-flaky-test-pattern-ratchet.mjs')
  return [...scripts].sort().map((script) => ({
    name: script.replace(/^check-|\.mjs$/g, ''),
    args: [`config/scripts/${script}`],
    inputs: RATCHET_INPUTS[script] ?? SOURCE_ROOTS,
    matches: (files) =>
      files.some(
        (file) =>
          /^config\/[^/]+-baseline\.txt$/.test(file) ||
          RATCHET_SHARED_MODULES[file]?.includes(script)
      )
  }))
}

function isSelected(check, files) {
  const stem = ownScriptStem(check)
  return (
    (stem !== undefined && files.some((file) => file.startsWith(stem))) ||
    files.some((file) => matchesPrefix(file, check.inputs ?? [])) ||
    (check.matches?.(files) ?? false)
  )
}

// `related` paths go through Vitest's import graph; `colocated` are explicit test files, either
// changed tests under a trigger path or the `<stem>.test.*` / `<stem>.*.test.*` siblings of one.
export function splitUnitTestInputs(files, listDirectory = () => []) {
  const related = files.filter(
    (file) => IMPORTABLE.test(file) && !FULL_SUITE_TRIGGER.test(file) && !isDocsOnlyPath(file)
  )
  const colocated = new Set()
  for (const file of files.filter((candidate) => FULL_SUITE_TRIGGER.test(candidate))) {
    if (UNIT_TEST_FILE.test(file)) {
      colocated.add(file)
      continue
    }
    const slash = file.lastIndexOf('/')
    const directory = file.slice(0, slash + 1)
    const stem = file.slice(slash + 1).replace(/\.[^.]+$/, '')
    for (const name of listDirectory(directory).map(String)) {
      if (UNIT_TEST_FILE.test(name) && name.startsWith(`${stem}.`)) {
        colocated.add(directory + name)
      }
    }
  }
  return { related, colocated: [...colocated].sort() }
}

/** Decides which checks a set of changed paths needs; CI's classifier gates the expensive jobs. */
export function planChangedChecks(files, { scriptsDir, listDirectory }) {
  const jobs = classifyPrJobs(files)
  const selectAll = files.some(
    (file) => SELECT_ALL_FILES.has(file) || matchesPrefix(file, SELECT_ALL_PREFIXES)
  )
  const checks = [...listRatchetChecks(scriptsDir), ...VERIFY_CHECKS]
  return {
    staticAnalysis: jobs.static_analysis,
    typecheckProjects: jobs.typecheck ? selectTypecheckProjects(files) : [],
    unitTests: jobs.test
      ? splitUnitTestInputs(files, listDirectory)
      : { related: [], colocated: [] },
    checks: jobs.static_analysis
      ? checks.filter((check) => selectAll || isSelected(check, files))
      : []
  }
}
