export function getOmpRootStatusSourceLines(): string[] {
  return String.raw`
  function boundedOmpRootText(value: unknown, limit: number): string | undefined {
    if (typeof value !== 'string') return undefined
    // Run the existing credential-path sanitizer before truncation can hide a reference.
    if (typeof sanitizeStatusToolInput(value) !== 'string') return undefined
    const text = value.slice(0, limit)
    const last = text.charCodeAt(text.length - 1)
    return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
  }

  function boundedOmpRootInput(value: unknown): unknown {
    const input = sanitizeStatusToolInput(value)
    try { return (JSON.stringify(input)?.length ?? 0) <= OMP_STATUS_INPUT_LIMIT ? input : { redacted: true } } catch { return { redacted: true } }
  }

  function isOmpQuestionTool(name: string | undefined): boolean {
    const normalized = name?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
    return normalized === 'ask' || normalized === 'askuserquestion' || normalized === 'requestuserinput'
  }

  function captureOmpRootStatus(name: string, event: OmpRootEvent | null | undefined, ctx: OmpRegistryContext): void {
    if (!isOmpRuntime() || !lifecycleState.ownsPane) return
    const observation = lifecycleState.ompRegistryObserver
    if (!observation || !currentOmpRegistryObservation(observation) || ctx?.sessionManager !== observation.manager || getOmpRegistryRootRef(pi, observation.registry, ctx) !== observation.root) return
    try {
      if (observation.manager.getSessionId?.() !== observation.sessionId || observation.manager.getSessionFile?.() !== observation.sessionFile) return
    } catch { return }
    let status = { ...observation.status }
    const toolName = boundedOmpRootText(event?.toolName, OMP_STATUS_TOOL_LIMIT)
    const baseline = name === 'session_start' || name === 'session_switch' || name === 'session_branch'
    if (baseline) {
      // Binding seeded a changed scope from native execution, not registration.
      // Same-scope baselines never replace captured turn or human-wait facts.
    } else if (name === 'before_agent_start') {
      status = { state: 'working', input_pending: false }
      const prompt = boundedOmpRootText(event?.prompt, OMP_STATUS_TEXT_LIMIT)
      if (prompt !== undefined) status.prompt = prompt
      observation.approvalPending = false
      observation.approvalDetails = undefined
      observation.questionToolName = undefined
    } else if (name === 'agent_start') {
      status.state = 'working'
      status.input_pending = false
      delete status.session_boundary
      delete status.tool_name
      delete status.tool_input
      observation.approvalPending = false
      observation.approvalDetails = undefined
      observation.questionToolName = undefined
    } else if (name === 'tool_approval_requested') {
      observation.approvalPending = true
      observation.approvalDetails = { tool_name: toolName, tool_input: boundedOmpRootText(event?.reason, OMP_STATUS_INPUT_LIMIT) }
      status.state = 'blocked'
      status.input_pending = true
      if (!observation.questionToolName) Object.assign(status, observation.approvalDetails)
    } else if (name === 'tool_approval_resolved') {
      observation.approvalPending = false
      observation.approvalDetails = undefined
      status.state = observation.questionToolName ? 'blocked' : 'working'
      status.input_pending = !!observation.questionToolName
      if (toolName && !observation.questionToolName) status.tool_name = toolName
    } else if (name === 'tool_call' || name === 'tool_execution_start') {
      const question = isOmpQuestionTool(toolName)
      if (question && toolName) {
        observation.questionToolName = toolName
        status.input_pending = true
      }
      status.state = observation.approvalPending || observation.questionToolName ? 'blocked' : 'working'
      // Parallel/unrelated tool traffic must not replace the human prompt or
      // permission details before its own native resolution arrives.
      if (question || (!observation.approvalPending && !observation.questionToolName)) {
        if (toolName) status.tool_name = toolName
        status.tool_input = boundedOmpRootInput(name === 'tool_call' ? event?.input : event?.args)
      }
    } else if (name === 'tool_execution_end') {
      if (toolName && toolName === observation.questionToolName) {
        observation.questionToolName = undefined
        status.input_pending = observation.approvalPending
        if (observation.approvalPending) {
          // A resolved ask reveals the still-pending native permission, not its old question.
          delete status.tool_name
          delete status.tool_input
          Object.assign(status, observation.approvalDetails)
        }
      }
      status.state = observation.approvalPending || observation.questionToolName ? 'blocked' : 'working'
      if (!observation.approvalPending && !observation.questionToolName) delete status.tool_input
    } else if (name === 'message_end') {
      if (event?.message?.role !== 'assistant') return
      const text = boundedOmpRootText(extractAssistantText(event.message), OMP_STATUS_TEXT_LIMIT)
      if (!text) return
      status.role = 'assistant'
      status.text = text
    } else if (name === 'agent_end' || name === 'agent_settled') {
      if (event?.willContinue === true) return
      status.state = 'done'
      status.input_pending = false
      delete status.session_boundary
      delete status.tool_name
      delete status.tool_input
      observation.approvalPending = false
      observation.approvalDetails = undefined
      observation.questionToolName = undefined
    } else return
    observation.status = status
    if (!baseline && name !== 'message_end') observation.rootBaselinePending = false
    observation.dirty = true
    if (name === 'agent_end' || name === 'agent_settled') {
      // The completion gate must see native children even when starts were missed.
      if (observation.changeTimer !== null) clearTimeout(observation.changeTimer)
      observation.changeTimer = null
      reconcileOmpRegistry(observation)
    } else scheduleOmpRegistryChange(observation)
    scheduleOmpRegistryRefresh(observation)
  }
`
    .trimEnd()
    .split('\n')
}
