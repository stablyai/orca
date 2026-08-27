import { z } from 'zod'

const MissionTopicSchema = z.string().trim().min(1).max(256)

const MissionAdmissionSchema = z.object({
  acceptedTypes: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  minPriority: z.enum(['normal', 'high', 'urgent']).optional().default('normal')
})

const MissionPlanTaskSchema = z.object({
  key: z.string().trim().min(1).max(128),
  spec: z.string().trim().min(1).max(32_768),
  deps: z.array(z.string().trim().min(1).max(128)).max(32).optional().default([]),
  publishesTo: z.array(MissionTopicSchema).min(1).max(32).optional(),
  requiredPublishesTo: z.array(MissionTopicSchema).min(1).max(32).optional(),
  subscribesTo: z.array(MissionTopicSchema).min(1).max(32).optional(),
  admission: MissionAdmissionSchema.optional()
})

const SingleAgentMissionPlanSchema = z.object({
  mode: z.literal('single-agent')
})

const OrchestrationMissionPlanSchema = z.object({
  mode: z.literal('orchestration'),
  objective: z.string().trim().min(1).max(32_768),
  maxConcurrency: z.number().int().min(1).max(32),
  tasks: z.array(MissionPlanTaskSchema).min(2).max(64)
})

const MissionPlanSchema = z.discriminatedUnion('mode', [
  SingleAgentMissionPlanSchema,
  OrchestrationMissionPlanSchema
])

export type MissionPlan = z.infer<typeof MissionPlanSchema>
export type MissionPlanTask = z.infer<typeof MissionPlanTaskSchema>

export function buildMissionPlanningPrompt(mission: string): string {
  return [
    'You are Orca Mission Planner. Decide whether this mission should run as one agent or as a deterministic multi-agent DAG.',
    '',
    'Return JSON only. Do not use markdown fences or explanatory prose.',
    '',
    'Use {"mode":"single-agent"} when one agent can execute the mission coherently without meaningful parallel work.',
    'Use orchestration when the user explicitly requests multiple agents, parallel work, or when there are genuinely separable tasks that benefit from dependency-aware execution.',
    'Do not invent extra tasks merely to increase agent count.',
    'Do not choose execution backends, agents, worktrees, terminals, Dispatch IDs, capabilities, retries, or scheduling mechanics. Orca owns execution authority.',
    'Task specs must be self-contained instructions for the worker that will execute them.',
    'When concurrently running tasks need to exchange intermediate information, declare semantic Topic strings with publishesTo/subscribesTo. Topics are communication channels, not task keys and not recipient identities.',
    'publishesTo is the allowlist of topics a worker may publish. If successful completion requires publishing on specific topics, also list those topics in requiredPublishesTo; requiredPublishesTo must be a subset of publishesTo.',
    'A task with subscribesTo must include admission with explicit acceptedTypes; minPriority defaults to normal. Do not declare collaboration fields when tasks are truly independent.',
    "deps only gate execution order; they do not inject another task's result into a worker.",
    "If a task needs another task's output, it must use collaboration topics even when deps also enforce ordering.",
    'Never make a task instruction forbid Orca control-plane actions. worker_done, heartbeat, and ask remain allowed and required protocol actions.',
    '',
    'Orchestration JSON shape:',
    '{"mode":"orchestration","objective":"...","maxConcurrency":2,"tasks":[{"key":"a","spec":"Investigate and publish required findings.","deps":[],"publishesTo":["/analysis/findings"],"requiredPublishesTo":["/analysis/findings"]},{"key":"b","spec":"Work independently and consume relevant findings at stage checkpoints.","deps":[],"subscribesTo":["/analysis/findings"],"admission":{"acceptedTypes":["finding"],"minPriority":"normal"}}]}',
    '',
    'Mission:',
    mission
  ].join('\n')
}

export function buildMissionPlanRepairPrompt(
  mission: string,
  invalidOutput: string,
  validationError: string
): string {
  return [
    buildMissionPlanningPrompt(mission),
    '',
    'Repair the previous Mission Planner output. Preserve the same execution intent; only correct the JSON shape and schema violations.',
    `Validation error: ${validationError.slice(0, 2_048)}`,
    'Previous output:',
    invalidOutput.slice(0, 16_384),
    '',
    'Return corrected JSON only.'
  ].join('\n')
}

export function parseMissionPlan(raw: string): MissionPlan {
  let decoded: unknown
  try {
    decoded = JSON.parse(stripMarkdownFence(raw))
  } catch {
    throw new Error('Mission planner returned invalid JSON.')
  }

  const parsed = MissionPlanSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error(
      `Mission planner returned an invalid plan: ${parsed.error.issues[0]?.message ?? 'invalid plan'}`
    )
  }
  if (parsed.data.mode === 'single-agent') {
    return parsed.data
  }

  const keys = new Set<string>()
  const publishedTopics = new Set(parsed.data.tasks.flatMap((task) => task.publishesTo ?? []))
  const subscribedTopics = new Set(parsed.data.tasks.flatMap((task) => task.subscribesTo ?? []))
  for (const task of parsed.data.tasks) {
    if (keys.has(task.key)) {
      throw new Error(`Duplicate Mission plan task key: ${task.key}`)
    }
    keys.add(task.key)
  }
  for (const task of parsed.data.tasks) {
    for (const dependency of task.deps) {
      if (!keys.has(dependency)) {
        throw new Error(`Unknown Mission plan dependency: ${dependency}`)
      }
    }
    const allowedPublishTopics = new Set(task.publishesTo ?? [])
    for (const topic of task.requiredPublishesTo ?? []) {
      if (!allowedPublishTopics.has(topic)) {
        throw new Error(
          `Mission plan task ${task.key} requiredPublishesTo must be a subset of publishesTo: ${topic}`
        )
      }
      if (!subscribedTopics.has(topic)) {
        throw new Error(
          `Mission plan task ${task.key} required publish topic has no subscriber: ${topic}`
        )
      }
    }
    if ((task.subscribesTo?.length ?? 0) > 0 && !task.admission) {
      throw new Error(`Mission plan task ${task.key} subscribesTo requires admission`)
    }
    for (const topic of task.subscribesTo ?? []) {
      if (!publishedTopics.has(topic)) {
        throw new Error(
          `Mission plan task ${task.key} subscribesTo topic has no publisher: ${topic}`
        )
      }
    }
  }
  assertAcyclicMissionTasks(parsed.data.tasks)
  return parsed.data
}

function assertAcyclicMissionTasks(
  tasks: readonly { key: string; deps: readonly string[] }[]
): void {
  const tasksByKey = new Map(tasks.map((task) => [task.key, task]))
  const states = new Map<string, 'visiting' | 'visited'>()

  const visit = (key: string): void => {
    const state = states.get(key)
    if (state === 'visiting') {
      throw new Error(`Mission plan task dependency cycle detected: ${key}`)
    }
    if (state === 'visited') {
      return
    }
    states.set(key, 'visiting')
    for (const dependency of tasksByKey.get(key)?.deps ?? []) {
      visit(dependency)
    }
    states.set(key, 'visited')
  }

  for (const task of tasks) {
    visit(task.key)
  }
}

function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}
