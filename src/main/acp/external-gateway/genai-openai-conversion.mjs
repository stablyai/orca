function textParts(parts) {
  return (parts ?? [])
    .map((part) => part.text ?? '')
    .filter(Boolean)
    .join('\n')
}

export function openAiMessagesFromGenAi(input) {
  const messages = []
  const system = input.systemInstruction ?? input.system_instruction
  const instructions = textParts(system?.parts)
  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }
  for (const item of input.contents ?? []) {
    const texts = []
    const functionCalls = []
    const functionResponses = []
    for (const part of item.parts ?? []) {
      if (part.text) {
        texts.push(part.text)
      }
      const call = part.functionCall ?? part.function_call
      if (call) {
        functionCalls.push(call)
      }
      const response = part.functionResponse ?? part.function_response
      if (response) {
        functionResponses.push(response)
      }
    }
    if (texts.length > 0 || functionCalls.length > 0) {
      messages.push({
        role: item.role === 'model' ? 'assistant' : 'user',
        content: texts.length > 0 ? texts.join('\n') : null,
        ...(functionCalls.length > 0
          ? {
              tool_calls: functionCalls.map((call) => ({
                id: call.id ?? call.call_id ?? call.name,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
              }))
            }
          : {})
      })
    }
    for (const response of functionResponses) {
      messages.push({
        role: 'tool',
        tool_call_id: response.id ?? response.call_id ?? response.name,
        name: response.name,
        content: JSON.stringify(response.response ?? {})
      })
    }
  }
  if (messages.length === 0) {
    throw new Error('External ACP input has no usable conversation content')
  }
  return messages
}

export function openAiToolsFromGenAi(tools) {
  return (tools ?? []).flatMap((group) =>
    (group.functionDeclarations ?? group.function_declarations ?? []).map((declaration) => ({
      type: 'function',
      function: {
        name: declaration.name,
        description: declaration.description ?? '',
        parameters: declaration.parametersJsonSchema ??
          declaration.parameters ?? {
            type: 'object',
            properties: {}
          }
      }
    }))
  )
}

function finishReason(value) {
  if (value === 'length') {
    return 'MAX_TOKENS'
  }
  if (value === 'content_filter') {
    return 'SAFETY'
  }
  return 'STOP'
}

function candidate(text, reason) {
  return {
    content: { role: 'model', parts: text ? [{ text }] : [] },
    index: 0,
    ...(reason ? { finishReason: reason } : {})
  }
}

function usage(event) {
  if (!event.usage) {
    return {}
  }
  return {
    usageMetadata: {
      promptTokenCount: event.usage.prompt_tokens ?? 0,
      candidatesTokenCount: event.usage.completion_tokens ?? 0,
      totalTokenCount: event.usage.total_tokens ?? 0
    }
  }
}

export class OpenAiStreamToGenAi {
  #toolCalls = new Map()

  accept(event) {
    const chunks = []
    for (const choice of event.choices ?? []) {
      const text = choice.delta?.content ?? choice.message?.content
      if (text) {
        if (typeof text !== 'string') {
          throw new Error('External ACP gateway returned malformed text')
        }
        chunks.push({ candidates: [candidate(text)] })
      }
      const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls ?? []
      for (const call of toolCalls) {
        const index = call.index ?? 0
        const existing = this.#toolCalls.get(index) ?? {
          id: call.id,
          name: call.function?.name,
          arguments: ''
        }
        existing.id = call.id ?? existing.id
        existing.name = call.function?.name ?? existing.name
        existing.arguments += call.function?.arguments ?? ''
        this.#toolCalls.set(index, existing)
      }
      if (choice.finish_reason) {
        chunks.push(...this.#finishTools())
        chunks.push({ candidates: [candidate('', finishReason(choice.finish_reason))] })
      }
    }
    if (event.usage) {
      chunks.push(usage(event))
    }
    return chunks
  }

  #finishTools() {
    const chunks = []
    for (const call of this.#toolCalls.values()) {
      if (!call.id || !call.name) {
        throw new Error('External ACP gateway returned an incomplete tool call')
      }
      let args
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {}
      } catch {
        throw new Error('External ACP gateway returned malformed tool arguments')
      }
      chunks.push({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { id: call.id, name: call.name, args } }]
            },
            index: 0
          }
        ]
      })
    }
    this.#toolCalls.clear()
    return chunks
  }
}

export function genAiEventsFromOpenAiSse(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line))
}

export function genAiSseFromOpenAiChunks(chunks) {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('')
}
