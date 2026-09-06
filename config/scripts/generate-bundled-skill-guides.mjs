import { constants } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parse } from 'yaml'

const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')

const CANONICAL_GUIDE_NAMES = [
  'computer-use',
  'linear-tickets',
  'orca-cli',
  'orca-emulator',
  'orca-emulator-android',
  'orca-linear',
  'orca-per-workspace-env',
  'orchestration'
]

// Why: old discovery stubs can outlive a rename indefinitely, so aliases are
// a compatibility ledger: add entries for renames, but never remove them.
const GUIDE_ALIASES = {
  'computer-use': [],
  'linear-tickets': [],
  'orca-cli': [],
  'orca-emulator': [],
  'orca-emulator-android': [],
  'orca-linear': [],
  'orca-per-workspace-env': [],
  orchestration: []
}

// Why: a stubbed topic ships a hybrid discovery stub as its installable projection while
// `orca skills get <topic>` still serves the full version-matched guide from the binary.
// Migrating a topic here is effectively one-way — earlier fat installs rely on the stub
// landing to converge — so entries are added as skills convert, never removed. The stub
// body lives in skill-stubs/<topic>.md; the projection reuses the guide's own frontmatter.
const STUB_TOPICS = [
  'computer-use',
  'linear-tickets',
  'orca-cli',
  'orca-emulator',
  'orca-emulator-android',
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

// Why: the stub's routing frontmatter (name + description) must stay byte-identical to the
// guide's — it is the unchanged discovery surface — so we reuse the guide's own block and
// replace only the body. Body normalized to LF with exactly one trailing newline.
function composeStubProjection(guideMarkdown, stubBody, sourcePath) {
  const block = frontmatterBlock(guideMarkdown, sourcePath)
  const body = normalizeMarkdown(stubBody).replace(/^\n+/, '').replace(/\n*$/, '\n')
  return `${block}\n${body}`
}

function constantName(name) {
  return `${name.replace(/-/g, '_').toUpperCase()}_MARKDOWN`
}

function fullConstantName(name) {
  return `${name.replace(/-/g, '_').toUpperCase()}_FULL_MARKDOWN`
}

function referenceConstantName(guideName, referenceName) {
  return `${`${guideName}_${referenceName}`.replace(/-/g, '_').toUpperCase()}_REFERENCE_MARKDOWN`
}

function composeFullMarkdown(markdown, references) {
  if (references.length === 0) {
    return markdown
  }
  const packageHeader =
    '\n\n---\n\n# Bundled references\n\n' +
    'These references belong to the version-matched guide above. Read only the documents ' +
    'named by its action gates.\n'
  const documents = references
    .map(
      ({ relativePath, markdown: referenceMarkdown }) =>
        `\n<!-- bundled-reference: ${relativePath} -->\n\n${referenceMarkdown.trimEnd()}\n`
    )
    .join('')
  return `${markdown.trimEnd()}${packageHeader}${documents}`
}

function serializeEmbeddedModule(guides) {
  const referenceConstants = guides.flatMap((guide) =>
    guide.references.map((reference) => referenceConstantName(guide.name, reference.name))
  )
  // Why: the constant name flattens guide and reference names, so two topics could otherwise
  // produce one identifier and silently serve the wrong reference.
  if (new Set(referenceConstants).size !== referenceConstants.length) {
    throw new Error(`Guide reference constant names collide: ${referenceConstants.join(', ')}`)
  }
  const markdownConstants = guides
    .flatMap((guide) => {
      const constants = [
        `// oxfmt-ignore\nconst ${constantName(guide.name)} = ${JSON.stringify(guide.markdown)}`
      ]
      if (guide.fullMarkdown !== guide.markdown) {
        constants.push(
          `// oxfmt-ignore\nconst ${fullConstantName(guide.name)} = ${JSON.stringify(guide.fullMarkdown)}`
        )
      }
      for (const reference of guide.references) {
        constants.push(
          `// oxfmt-ignore\nconst ${referenceConstantName(guide.name, reference.name)} = ${JSON.stringify(reference.markdown)}`
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
        `    fullMarkdown: ${guide.fullMarkdown === guide.markdown ? markdownConstant : fullConstantName(guide.name)},`,
        `    aliases: ${JSON.stringify(guide.aliases)},`,
        `    references: [${referenceEntries}]`,
        '  }'
      ].join('\n')
    })
    .join(',\n')

  return `// Generated by config/scripts/generate-bundled-skill-guides.mjs. Do not edit.\n\nexport type BundledSkillGuideReference = {\n  readonly name: string\n  readonly markdown: string\n}\n\nexport type BundledSkillGuide = {\n  readonly name: string\n  readonly description: string\n  readonly markdown: string\n  readonly fullMarkdown: string\n  readonly aliases: readonly string[]\n  readonly references: readonly BundledSkillGuideReference[]\n}\n\n${markdownConstants}\n\n// oxfmt-ignore\nexport const BUNDLED_SKILL_GUIDES = [\n${guideEntries}\n] as const satisfies readonly BundledSkillGuide[]\n`
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
        return { name: entry.name.slice(0, -3), relativePath: `references/${entry.name}`, markdown }
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
    // Why: a repo state with no stubbed topics yet has no skill-stubs directory at all.
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

// Why: path.relative yields `\` on Windows, but these paths are asserted in tests and pasted into commands.
// split(sep) rather than replaceAll('\\', '/') so a POSIX filename containing a backslash survives intact.
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
  const guides = []
  const projections = []
  for (const name of expectedNames) {
    const sourcePath = path.join(guideRoot, `${name}.md`)
    // Why: Git may render text with native EOLs despite repository policy; the
    // embedded guide and generated projection must have one platform-neutral identity.
    const markdown = normalizeMarkdown(await readFile(sourcePath, 'utf8'))
    const frontmatter = parseFrontmatter(markdown, toPosixRelativePath(repoRoot, sourcePath))
    if (frontmatter.name !== name) {
      throw new Error(`Guide source ${name}.md declares mismatched name ${frontmatter.name}`)
    }
    const aliases = GUIDE_ALIASES[name]
    const references = await readGuideReferences(repoRoot, name)
    // Why: the embedded table always carries the full guide (served by `skills get`);
    // only the installable projection thins to a stub once a topic is in STUB_TOPICS.
    guides.push({
      name,
      description: frontmatter.description,
      markdown,
      fullMarkdown: composeFullMarkdown(markdown, references),
      aliases,
      // Why: `skills get --reference` serves one of these alone, so it keeps the
      // per-file identity that fullMarkdown's concatenation erases.
      references: references.map(({ name: referenceName, markdown: referenceMarkdown }) => ({
        name: referenceName,
        markdown: referenceMarkdown
      }))
    })
    const stubPath = path.join(repoRoot, 'skill-stubs', `${name}.md`)
    const content = stubTopics.has(name)
      ? composeStubProjection(markdown, await readFile(stubPath, 'utf8'), `skill-stubs/${name}.md`)
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
  composeFullMarkdown,
  composeStubProjection,
  frontmatterBlock,
  normalizeMarkdown,
  parseFrontmatter,
  serializeEmbeddedModule,
  toPosixRelativePath,
  verifyArtifacts,
  writeArtifacts
}
