import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../../src/cli/bundled-skill-guides'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const guidePath = path.join(projectDir, 'skill-guides', 'graphify.md')

async function readGuide() {
  return await readFile(guidePath, 'utf8')
}

describe('Graphify skill guidance', () => {
  it('pins one Graphify package version and one interpreter-backed CLI', async () => {
    const source = await readGuide()

    expect(source).toContain('graphify_package: graphifyy==0.9.32')
    expect(
      BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'graphify')?.packageRequirement
    ).toBe('graphifyy==0.9.32')
    expect(source).not.toMatch(/uv tool run --from graphifyy(?:\s|$)/u)
    expect(source).not.toMatch(/(?:pip install|uv tool install --upgrade) graphifyy(?:\s|$)/u)
    expect(source).not.toMatch(
      /^graphify (?:benchmark|clone|cluster-only|explain|export|extract|hook|install|merge-graphs|path|query|reflect|save-result|uninstall)\b/mu
    )
    expect(source).not.toContain('Run `graphify query "<question>"` immediately')
    expect(source).toContain('GRAPHIFY_CLI_PYTHON')
    expect(source).toContain("m.version('graphifyy') == '0.9.32'")
    expect(source).not.toMatch(/"\$GRAPHIFY_PYTHON" -m graphify\b/u)
    expect(source).not.toContain('run `graphify reflect')
  })

  it('installs every advertised optional backend in the pinned environment', async () => {
    const source = await readGuide()

    for (const extra of ['gemini', 'mcp', 'neo4j', 'falkordb', 'svg', 'watch', 'video']) {
      expect(source, extra).toContain(`graphifyy[${extra}]==0.9.32`)
    }
  })

  it('keeps dynamic values out of embedded Python source and secrets out of argv', async () => {
    const source = await readGuide()

    for (const unsafe of [
      "Path('INPUT_PATH')",
      "root='INPUT_PATH'",
      "question = 'QUESTION'",
      "ingest('URL'",
      "prompt_file='SPEC_PATH'",
      'labels = LABELS_DICT',
      'GRAPHIFY_WHISPER_PROMPT="<',
      '--question "ORIGINAL_QUESTION"',
      '--password PASSWORD'
    ]) {
      expect(source).not.toContain(unsafe)
    }
    expect(source).toContain('sys.argv[1]')
    expect(source).toContain('NEO4J_PASSWORD')
    expect(source).toContain('.graphify_spec_path')
    expect(source).toContain('.graphify_labels_input.json')
    expect(source).toContain('.graphify_whisper_prompt.txt')
    expect(source).toContain('.graphify_save_result.json')
  })

  it('uses capability-driven semantic extraction instead of Claude-only tool names', async () => {
    const source = await readGuide()

    expect(source).not.toContain('You MUST use the Agent tool')
    expect(source).not.toContain('subagent_type="general-purpose"')
    expect(source).toContain('If the host can dispatch write-capable subagents')
    expect(source).toContain('If no subagent capability exists')
  })

  it('does not ship generated wrapper markers', async () => {
    const source = await readGuide()
    const stub = await readFile(path.join(projectDir, 'skill-stubs', 'graphify.md'), 'utf8')

    expect(source).not.toContain('</content>')
    expect(stub).not.toContain('</content>')
  })
})
