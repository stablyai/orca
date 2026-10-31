import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'
import {
  SHARED_STUB_SOURCE,
  parseSharedStubBlocks,
  renderSharedStubBody
} from './skill-stub-composition.mjs'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

const CANONICAL_GUIDE_NAMES = [
  'computer-use',
  'jira-tickets',
  'linear-tickets',
  'orca-cli',
  'orca-emulator',
  'orca-emulator-android',
  'orca-jira',
  'orca-linear',
  'orca-per-workspace-env',
  'orchestration'
]

// Aliases preserve renamed discovery stubs; append ledger entries, never remove them.
const GUIDE_ALIASES = {
  'computer-use': [],
  'jira-tickets': [],
  'linear-tickets': [],
  'orca-cli': [],
  'orca-emulator': [],
  'orca-emulator-android': [],
  'orca-jira': [],
  'orca-linear': [],
  'orca-per-workspace-env': [],
  orchestration: []
}

// Stubbed topics install thin projections but skills get serves full version-matched guides.
// Migration is one-way: old fat installs need new stubs to converge, so only add STUB_TOPICS; bodies live in skill-stubs/<topic>.md.
const STUB_TOPICS = [
  'computer-use',
  'jira-tickets',
  'linear-tickets',
  'orca-cli',
  'orca-emulator',
  'orca-emulator-android',
  'orca-jira',
  'orca-linear',
  'orca-per-workspace-env',
  'orchestration'
]

function normalizeMarkdown(markdown) {
  return markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function parseFrontmatter(markdown, sourcePath) {
  const normalized = normalizeMarkdown(markdown)
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(normalized)
  if (!match) {
    throw new Error(`Guide source has no YAML frontmatter: ${sourcePath}`)
  }
  let values
  try {
    values = parse(match[1])
  } catch (error) {
    throw new Error(
      `Guide source has invalid YAML frontmatter: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (
    !values ||
    typeof values !== 'object' ||
    typeof values.name !== 'string' ||
    typeof values.description !== 'string'
  ) {
    throw new Error(`Guide source must declare name and description: ${sourcePath}`)
  }
  return {
    name: values.name,
    description: values.description.replace(/\s+/g, ' ').trim()
  }
}

function frontmatterBlock(markdown, sourcePath) {
  const normalized = normalizeMarkdown(markdown)
  const match = /^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/.exec(normalized)
  if (!match) {
    throw new Error(`Guide source has no YAML frontmatter block: ${sourcePath}`)
  }
  return match[0]
}

// Reuse byte-identical guide routing frontmatter; expand stub markers and normalize body to LF plus one trailing newline.
function composeStubProjection(guideMarkdown, stubBody, sourcePath, { sharedBlocks }) {
  const block = frontmatterBlock(guideMarkdown, sourcePath)
  const composed = renderSharedStubBody(normalizeMarkdown(stubBody), {
    blocks: sharedBlocks,
    sourcePath
  })
  const body = composed.replace(/^\n+/, '').replace(/\n*$/, '\n')
  return `${block}\n${body}`
}

async function readSharedStubBlocks(repoRoot) {
  const sourcePath = path.join(repoRoot, ...SHARED_STUB_SOURCE.split('/'))
  let markdown
  try {
    markdown = normalizeMarkdown(await readFile(sourcePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Stub topics require the shared fragment: ${SHARED_STUB_SOURCE}`)
    }
    throw error
  }
  return parseSharedStubBlocks(markdown, SHARED_STUB_SOURCE)
}

function constantName(name) {
  return `${name.replace(/-/g, '_').toUpperCase()}_MARKDOWN`
}

function referenceConstantName(guideName, referenceName) {
  return `${`${guideName}_${referenceName}`.replace(/-/g, '_').toUpperCase()}_REFERENCE_MARKDOWN`
}

function serializeMarkdown(markdown) {
  const lines = markdown.split('\n').map((line) => `  ${JSON.stringify(line)},`)
  return `[\n${lines.join('\n')}\n].join('\\n')`
}

function serializeEmbeddedModule(guides) {
  const referenceConstants = guides.flatMap((guide) =>
    guide.references.map((reference) => referenceConstantName(guide.name, reference.name))
  )
  // Flattened guide/reference constant names can collide and silently serve the wrong reference.
  if (new Set(referenceConstants).size !== referenceConstants.length) {
    throw new Error(`Guide reference constant names collide: ${referenceConstants.join(', ')}`)
  }
  const markdownConstants = guides
    .flatMap((guide) => {
      const constants = [
        `// oxfmt-ignore\nconst ${constantName(guide.name)} = ${serializeMarkdown(guide.markdown)}`
      ]
      for (const reference of guide.references) {
        constants.push(
          `// oxfmt-ignore\nconst ${referenceConstantName(guide.name, reference.name)} = ${serializeMarkdown(reference.markdown)}`
        )
      }
      return constants
    })
    .join('\n\n')
  const guideEntries = guides
    .map((guide) => {
      const markdownConstant = constantName(guide.name)
      const referenceEntries = guide.references
        .map(
          (reference) =>
            `{ name: ${JSON.stringify(reference.name)}, markdown: ${referenceConstantName(guide.name, reference.name)} }`
        )
        .join(', ')
      return [
        '  {',
        `    name: ${JSON.stringify(guide.name)},`,
        `    description: ${JSON.stringify(guide.description)},`,
        `    markdown: ${markdownConstant},`,
        `    aliases: ${JSON.stringify(guide.aliases)},`,
        `    references: [${referenceEntries}]`,
        '  }'
      ].join('\n')
    })
    .join(',\n')

  return `// Generated by config/scripts/generate-bundled-skill-guides.mjs. Do not edit.\n\nexport type BundledSkillGuideReference = {\n  readonly name: string\n  readonly markdown: string\n}\n\nexport type BundledSkillGuide = {\n  readonly name: string\n  readonly description: string\n  readonly markdown: string\n  readonly aliases: readonly string[]\n  readonly references: readonly BundledSkillGuideReference[]\n}\n\n${markdownConstants}\n\n// oxfmt-ignore\nexport const BUNDLED_SKILL_GUIDES = [\n${guideEntries}\n] as const satisfies readonly BundledSkillGuide[]\n`
}

async function readGuideReferences(repoRoot, guideName) {
  const referenceRoot = path.join(repoRoot, 'skill-guides', guideName, 'references')
  let entries
  try {
    entries = await readdir(referenceRoot, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }
    throw error
  }
  const unsupported = entries.find((entry) => !entry.isFile() || !entry.name.endsWith('.md'))
  if (unsupported) {
    throw new Error(
      `Guide references must be Markdown files: skill-guides/${guideName}/references/${unsupported.name}`
    )
  }
  return Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .map(async (entry) => {
        const sourcePath = path.join(referenceRoot, entry.name)
        const markdown = normalizeMarkdown(await readFile(sourcePath, 'utf8'))
        if (!markdown.trim()) {
          throw new Error(`Guide reference is empty: ${toPosixRelativePath(repoRoot, sourcePath)}`)
        }
        return { name: entry.name.slice(0, -3), markdown }
      })
  )
}

function assertAliasContract(guides) {
  const canonicalNames = new Set(guides.map((guide) => guide.name))
  const seenAliases = new Set()
  for (const guide of guides) {
    for (const alias of guide.aliases) {
      if (canonicalNames.has(alias)) {
        throw new Error(`Guide alias collides with canonical name: ${alias}`)
      }
      if (seenAliases.has(alias)) {
        throw new Error(`Guide alias is assigned more than once: ${alias}`)
      }
      seenAliases.add(alias)
    }
  }
}

async function assertStubSourcesMatchTopics(repoRoot) {
  const stubRoot = path.join(repoRoot, 'skill-stubs')
  let names = []
  try {
    names = (await readdir(stubRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
  } catch (error) {
    // Before first stub migration, skill-stubs need not exist.
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  const found = names.sort((left, right) => left.localeCompare(right, 'en'))
  const expected = [...STUB_TOPICS].sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    throw new Error(
      `skill-stubs sources must match STUB_TOPICS.\nExpected: ${expected.join(', ') || '(none)'}\nFound: ${found.join(', ') || '(none)'}`
    )
  }
  for (const name of STUB_TOPICS) {
    if (!CANONICAL_GUIDE_NAMES.includes(name)) {
      throw new Error(`Stub topic is not a canonical guide: ${name}`)
    }
  }
}

// Normalize Windows separators for commands/tests with split(sep), preserving literal POSIX backslashes.
function toPosixRelativePath(repoRoot, filePath, pathModule = path) {
  return pathModule.relative(repoRoot, filePath).split(pathModule.sep).join('/')
}

async function buildArtifacts(repoRoot = REPO_ROOT) {
  const guideRoot = path.join(repoRoot, 'skill-guides')
  const sourceFiles = (await readdir(guideRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .sort((left, right) => left.localeCompare(right, 'en'))
  const expectedNames = [...CANONICAL_GUIDE_NAMES].sort((left, right) =>
    left.localeCompare(right, 'en')
  )
  if (JSON.stringify(sourceFiles) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `Guide sources must match the canonical topic list.\nExpected: ${expectedNames.join(', ')}\nFound: ${sourceFiles.join(', ')}`
    )
  }
  await assertStubSourcesMatchTopics(repoRoot)

  const stubTopics = new Set(STUB_TOPICS)
  const sharedBlocks = stubTopics.size > 0 ? await readSharedStubBlocks(repoRoot) : new Map()
  const guides = []
  const projections = []
  for (const name of expectedNames) {
    const sourcePath = path.join(guideRoot, `${name}.md`)
    // Normalize Git’s native EOLs so embedded guides/projections retain platform-neutral identity.
    const markdown = normalizeMarkdown(await readFile(sourcePath, 'utf8'))
    const frontmatter = parseFrontmatter(markdown, toPosixRelativePath(repoRoot, sourcePath))
    if (frontmatter.name !== name) {
      throw new Error(`Guide source ${name}.md declares mismatched name ${frontmatter.name}`)
    }
    const aliases = GUIDE_ALIASES[name]
    const references = await readGuideReferences(repoRoot, name)
    // Embedded skills get table retains full guides; only installable STUB_TOPICS projections thin.
    guides.push({
      name,
      description: frontmatter.description,
      markdown,
      aliases,
      references
    })
    const stubPath = path.join(repoRoot, 'skill-stubs', `${name}.md`)
    const content = stubTopics.has(name)
      ? composeStubProjection(
          markdown,
          await readFile(stubPath, 'utf8'),
          `skill-stubs/${name}.md`,
          { sharedBlocks }
        )
      : markdown
    projections.push({
      path: path.join(repoRoot, 'skills', name, 'SKILL.md'),
      content
    })
  }
  assertAliasContract(guides)

  return [
    {
      path: path.join(repoRoot, 'src', 'cli', 'bundled-skill-guides.ts'),
      content: serializeEmbeddedModule(guides)
    },
    ...projections
  ]
}

async function writeArtifacts(artifacts) {
  for (const artifact of artifacts) {
    await mkdir(path.dirname(artifact.path), { recursive: true })
    await writeFile(artifact.path, artifact.content, 'utf8')
  }
}

async function verifyArtifacts(artifacts, repoRoot = REPO_ROOT) {
  const stale = []
  for (const artifact of artifacts) {
    try {
      await access(artifact.path, constants.R_OK)
      if ((await readFile(artifact.path, 'utf8')) !== artifact.content) {
        stale.push(artifact.path)
      }
    } catch {
      stale.push(artifact.path)
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated bundled skill guides are stale:\n${stale
        .map((filePath) => toPosixRelativePath(repoRoot, filePath))
        .join('\n')}\nRun node config/scripts/generate-bundled-skill-guides.mjs --write.`
    )
  }
}

async function main() {
  const artifacts = await buildArtifacts()
  await (process.argv.includes('--write') ? writeArtifacts : verifyArtifacts)(artifacts)
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export {
  CANONICAL_GUIDE_NAMES,
  GUIDE_ALIASES,
  STUB_TOPICS,
  assertAliasContract,
  buildArtifacts,
  composeStubProjection,
  frontmatterBlock,
  normalizeMarkdown,
  parseFrontmatter,
  readSharedStubBlocks,
  serializeEmbeddedModule,
  toPosixRelativePath,
  verifyArtifacts,
  writeArtifacts
}
