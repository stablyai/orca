/** Native DSH lifecycle evidence, posted through the existing managed hook transport. */
export function getDshStatusPluginSource(command: string): string {
  return `
export const name = 'orca-dsh-status'
export const inject = ['shell']

export function apply(ctx) {
  const controller = new AbortController()
  let queue = Promise.resolve()
  let revision = 0
  ctx.effect(() => () => controller.abort())
  function isLead(agent) {
    return agent && !agent.parentAgent && !agent.session.header.parentSession && agent.session.header.origin !== 'subagent'
  }
  function post(agent, hook_event_name, fields = {}, observedIdle) {
    if (!isLead(agent)) return
    queue = queue.then(async () => {
      if (controller.signal.aborted) return
      if (observedIdle !== undefined && (observedIdle !== revision || agent.status !== 'idle' || agent.inbox.hasPending)) return
      const request = ctx.shell.resolve({
        command: ${JSON.stringify(command)},
        timeoutMs: 5000,
        signal: controller.signal,
        workdir: agent.session.header.cwd,
        stdin: JSON.stringify({ hook_event_name, session_id: agent.session.header.id, cwd: agent.session.header.cwd, ...fields }) + '\\n'
      })
      await (await ctx.shell.execute(request)).result()
    }).catch(error => {
      if (!controller.signal.aborted) ctx.logger.warn('Orca status hook failed: ' + String(error))
    })
    return queue
  }
  ctx.on('agent/created', ({ agent }) => post(agent, 'SessionStart'))
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    if (messages.length) await post(agent, 'UserPromptSubmit', {
      prompt: messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\\n')
    })
    return next()
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    await post(exec.agent, 'PreToolUse', { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId })
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    await post(exec.agent, 'PostToolUse', { tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: result.content?.filter(block => block.type === 'text').map(block => block.text).join('\\n') })
    return next()
  })
  ctx.on('agent/status', ({ agent, status }) => {
    // Global DSH listeners also see descendant agents; only the pane's lead owns readiness.
    if (!isLead(agent)) return
    if (status !== 'running' && status !== 'idle') return
    const observed = ++revision
    // Use the ordered PTY carrier for readiness; the shell transport can finish after a wake-up.
    if (process.stdout.isTTY === true && (process.env.ORCA_AGENT_PANE || process.env.ORCA_PANE_KEY) && (status !== 'idle' || !agent.inbox.hasPending)) {
      process.stdout.write('\\x1b]9999;' + JSON.stringify({ state: status === 'idle' ? 'done' : 'working', agentType: 'dsh' }) + '\\x07')
    }
    post(agent, status === 'idle' ? 'NativeIdle' : 'NativeRunning', {}, status === 'idle' ? observed : undefined)
  })
}
`
}
