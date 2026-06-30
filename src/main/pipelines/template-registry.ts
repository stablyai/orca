import type {
  PipelinePromptDefinition,
  PipelineTemplate,
  PipelineTemplateSummary
} from '../../shared/pipeline-template-types'

const PLANNER_PROMPT = `# ISSUES

Here are the prepared tasks:

<issues-json>

!\`{{LIST_TASKS_COMMAND}}\`

</issues-json>

# TASK

Analyze the prepared tasks and build a dependency graph. Include only tasks that can be worked on in parallel now.

For each selected task, assign a deterministic branch name.

# OUTPUT

Output exactly one XML-style block whose tag name is "plan": opening tag, JSON body,
then matching closing tag.

The block body must be JSON with this shape:

{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "pipeline/issue-42"}]}

When there is no work, output the same block with {"issues":[]} as the JSON body.`

const IMPLEMENTER_PROMPT = `# TASK

Implement task {{TASK_ID}}: {{ISSUE_TITLE}}

Read the task with:

{{VIEW_TASK_COMMAND}}

Work on branch {{BRANCH}}. Make the smallest complete code change and run relevant checks.

When complete, output an XML-style block whose tag name is "promise": opening tag,
COMPLETE as the body, then matching closing tag.`

const REVIEWER_PROMPT = `# TASK

Review branch {{BRANCH}} against {{TARGET_BRANCH}}.

# CONTEXT

Branch diff:

!\`git diff {{TARGET_BRANCH}}...{{BRANCH}}\`

Branch commits:

!\`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline\`

Preserve behavior. Improve clarity only when needed.

When complete, output an XML-style block whose tag name is "promise": opening tag,
COMPLETE as the body, then matching closing tag.`

const MERGER_PROMPT = `# TASK

Merge these branches into the current branch:

{{BRANCHES}}

After merging, run the configured verification commands.

# CLOSE TASKS

Use this command for completed tasks:

{{CLOSE_TASK_COMMAND}}

Tasks:

{{ISSUES}}

When complete, output an XML-style block whose tag name is "promise": opening tag,
COMPLETE as the body, then matching closing tag.`

const VERIFIER_PROMPT = `Run the configured verification commands and report exact failures.`

export class PipelineTemplateRegistry {
  private readonly templates: Map<string, PipelineTemplate>

  constructor(templates: PipelineTemplate[]) {
    this.templates = new Map()
    for (const template of templates) {
      validateTemplate(template)
      if (this.templates.has(template.id)) {
        throw new Error(`Duplicate Pipeline template id: ${template.id}`)
      }
      this.templates.set(template.id, template)
    }
  }

  listTemplates(): PipelineTemplateSummary[] {
    return [...this.templates.values()].map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      version: template.version,
      maxIterationsDefault: template.maxIterationsDefault,
      maxConcurrentDefault: template.maxConcurrentDefault
    }))
  }

  getTemplate(id: string): PipelineTemplate | undefined {
    return this.templates.get(id)
  }
}

export function createBuiltInPipelineTemplateRegistry(): PipelineTemplateRegistry {
  return new PipelineTemplateRegistry([
    PARALLEL_PLANNER_WITH_REVIEW_TEMPLATE,
    SEQUENTIAL_REVIEWER_TEMPLATE
  ])
}

function prompt(
  id: string,
  stage: PipelinePromptDefinition['stage'],
  text: string,
  acceptsArgs = true
): PipelinePromptDefinition {
  return {
    id,
    stage,
    source: { type: 'template', text },
    acceptsArgs
  }
}

const PARALLEL_PLANNER_WITH_REVIEW_TEMPLATE: PipelineTemplate = {
  id: 'parallel-planner-with-review',
  name: 'Parallel Planner With Review',
  description: 'Plans prepared tasks, implements in task worktrees, reviews, merges, and verifies.',
  version: 1,
  maxIterationsDefault: 10,
  maxConcurrentDefault: 2,
  stages: [
    { stage: 'task_source', description: 'Snapshot prepared task source output.' },
    { stage: 'planner', description: 'Select runnable tasks and deterministic branches.' },
    { stage: 'implement', description: 'Run implementer agents in task worktrees.' },
    { stage: 'review', description: 'Review branches that produced commits.' },
    { stage: 'merge', description: 'Merge completed task branches.' },
    { stage: 'verify', description: 'Run configured verification commands.' }
  ],
  prompts: {
    planner: prompt('parallel-planner-with-review/planner', 'planner', PLANNER_PROMPT),
    implementer: prompt(
      'parallel-planner-with-review/implementer',
      'implement',
      IMPLEMENTER_PROMPT
    ),
    reviewer: prompt('parallel-planner-with-review/reviewer', 'review', REVIEWER_PROMPT),
    merger: prompt('parallel-planner-with-review/merger', 'merge', MERGER_PROMPT),
    verifier: {
      id: 'parallel-planner-with-review/verifier',
      stage: 'verify',
      source: { type: 'inline', text: VERIFIER_PROMPT },
      acceptsArgs: false
    }
  },
  plannerOutput: { tag: 'plan', version: 1 },
  taskSourceKinds: ['github_issues'],
  safety: {
    dynamicContextTimeoutMs: 30_000,
    maxStdoutChars: 32_000,
    maxStderrChars: 8_000,
    strictUnusedArgs: false
  }
}

const SEQUENTIAL_REVIEWER_TEMPLATE: PipelineTemplate = {
  ...PARALLEL_PLANNER_WITH_REVIEW_TEMPLATE,
  id: 'sequential-reviewer',
  name: 'Sequential Reviewer',
  description: 'Strict one-issue-at-a-time Pipeline mode with closure before the next issue.',
  maxConcurrentDefault: 1,
  prompts: {
    ...PARALLEL_PLANNER_WITH_REVIEW_TEMPLATE.prompts,
    planner: prompt('sequential-reviewer/planner', 'planner', PLANNER_PROMPT),
    implementer: prompt('sequential-reviewer/implementer', 'implement', IMPLEMENTER_PROMPT),
    reviewer: prompt('sequential-reviewer/reviewer', 'review', REVIEWER_PROMPT),
    merger: prompt('sequential-reviewer/merger', 'merge', MERGER_PROMPT)
  },
  taskSourceKinds: ['github_issues']
}

function validateTemplate(template: PipelineTemplate): void {
  if (!template.id) {
    throw new Error('Pipeline template id is required')
  }
  if (!template.prompts.planner) {
    throw new Error(`Pipeline template ${template.id} is missing planner prompt`)
  }
  if (!template.prompts.implementer) {
    throw new Error(`Pipeline template ${template.id} is missing implementer prompt`)
  }
  if (!template.prompts.merger) {
    throw new Error(`Pipeline template ${template.id} is missing merger prompt`)
  }
  if (template.maxIterationsDefault < 1) {
    throw new Error(`Pipeline template ${template.id} maxIterationsDefault must be >= 1`)
  }
  if (template.maxConcurrentDefault < 1) {
    throw new Error(`Pipeline template ${template.id} maxConcurrentDefault must be >= 1`)
  }
}
