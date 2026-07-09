import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

export function wikiTemplatesDirCandidates(env: {
  isPackaged: boolean
  resourcesPath: string | undefined
  appPath: string
}): string[] {
  const candidates: string[] = []
  // Why: electron-builder ships resources/ via asarUnpack, which lands under
  // app.asar.unpacked/resources rather than directly under Resources — probe
  // both plus the unpacked-app-path fallback (mirrors getLocalRelayCandidates).
  if (env.isPackaged && env.resourcesPath) {
    candidates.push(join(env.resourcesPath, 'wiki-templates'))
    candidates.push(join(env.resourcesPath, 'app.asar.unpacked', 'resources', 'wiki-templates'))
  }
  candidates.push(join(env.appPath, 'resources', 'wiki-templates'))
  return [...new Set(candidates)]
}

export function resolveWikiTemplatesDir(): string {
  return wikiTemplatesDirCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })[0]
}

const CLAUDE_MD_INSTRUCTION = [
  '',
  '## Also update CLAUDE.md',
  'In addition to the wiki, ensure a `CLAUDE.md` file exists at the repository root and contains a',
  'short instruction about the wiki. If `CLAUDE.md` does not exist, create it. If it exists but has',
  'no wiki section, append one; do not duplicate an existing wiki section. The instruction must tell',
  'future agents: this repository has a `.wiki/` folder (root `.wiki/Home.md`) documenting the',
  'project — keep it up to date when changing architecture, data, interfaces, or business logic.'
].join('\n')

export async function buildWikiGenerationPrompt(input: {
  repoName: string
  readTemplateFile: (name: string) => Promise<string>
  addClaudeMdInstruction?: boolean
}): Promise<string> {
  const [contract, overview, service, task] = await Promise.all([
    input.readTemplateFile('prompt.md'),
    input.readTemplateFile('overview.md'),
    input.readTemplateFile('service.md'),
    input.readTemplateFile('task.md')
  ])
  const sections = [
    contract.trim(),
    `\nRepository: **${input.repoName}**. Generate the wiki in the \`.wiki/\` folder of this repository.`
  ]
  if (input.addClaudeMdInstruction) {
    sections.push(CLAUDE_MD_INSTRUCTION)
  }
  sections.push(
    '\n---\n## Template: repository (overview)\n',
    overview.trim(),
    '\n---\n## Template: service\n',
    service.trim(),
    '\n---\n## Template: task\n',
    task.trim()
  )
  return sections.join('\n')
}

export async function readWikiTemplateFile(name: string): Promise<string> {
  const candidates = wikiTemplatesDirCandidates({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath()
  })
  const triedPaths: string[] = []
  for (const dir of candidates) {
    const filePath = join(dir, name)
    triedPaths.push(filePath)
    try {
      return await readFile(filePath, 'utf8')
    } catch {
      // Why: try the next candidate; only surface a failure once all are exhausted.
    }
  }
  throw new Error(`Wiki template "${name}" not found. Tried: ${triedPaths.join(', ')}`)
}
