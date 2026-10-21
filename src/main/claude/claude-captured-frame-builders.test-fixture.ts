// The frame shapes a captured Claude stream is rebuilt from, keeping only what the child-work path reads.

export type CapturedFrame = { at: number; frame: Record<string, unknown> }

export function spawn(
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null
) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }]
    }
  }
}

export function toolResult(
  toolUseId: string,
  content: string,
  parent: string | null,
  isError?: boolean
) {
  return {
    type: 'user',
    parent_tool_use_id: parent,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError === undefined ? {} : { is_error: isError })
        }
      ]
    }
  }
}

export function says(id: string, text: string, parent: string | null) {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'text', text }] }
  }
}

export function system(subtype: string, fields: Record<string, unknown>) {
  return { type: 'system', subtype, ...fields }
}

export const result = (subtype: string) => ({
  type: 'result',
  subtype,
  is_error: subtype !== 'success'
})
