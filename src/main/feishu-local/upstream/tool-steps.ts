/** Copyright (c) 2026 ByteDance Ltd. and/or its affiliates. SPDX-License-Identifier: MIT
 * Adapted from larksuite/openclaw-lark@dde0be3680d6fd5443cab426c8f4b3216266346a; see UPSTREAM.md. */
export type CardElement = Record<string, unknown>
export type ToolUseDisplayStep = {
  title: string
  iconToken: string
  detail?: string
  status: 'running' | 'success' | 'error'
  durationMs?: number
}
const TOOL_USE_STEP_CONTENT_INDENT = '0px 0px 0px 22px'
export function buildToolUseStepElements(step: ToolUseDisplayStep): CardElement[] {
  const elements: CardElement[] = [buildToolUseStepTitleElement(step)]
  const detailElement = buildToolUseStepDetailElement(step)
  if (detailElement) {
    elements.push(detailElement)
  }
  return elements
}

export function buildToolUseStepTitleElement(step: ToolUseDisplayStep): CardElement {
  return {
    tag: 'div',
    icon: {
      tag: 'standard_icon',
      token: step.iconToken,
      color: 'grey'
    },
    text: {
      tag: 'lark_md',
      content: buildToolUseStepTitleMarkdown(step),
      text_size: 'notation'
    }
  }
}

export function buildToolUseStepTitleMarkdown(step: ToolUseDisplayStep): string {
  const status = formatToolUseStepStatus(step.status)
  return `**${escapeToolUseMarkdownText(step.title)}** · <font color='${status.color}'>${status.label}</font>`
}

export function buildToolUseStepDetailElement(step: ToolUseDisplayStep): CardElement | undefined {
  const detail = step.detail?.trim()
  if (!detail) {
    return undefined
  }
  return {
    tag: 'div',
    margin: TOOL_USE_STEP_CONTENT_INDENT,
    text: {
      tag: 'plain_text',
      content: detail,
      text_color: 'grey',
      text_size: 'notation'
    }
  }
}

export function formatToolUseStepStatus(status: ToolUseDisplayStep['status']): {
  label: string
  color: string
} {
  switch (status) {
    case 'running':
      return { label: '执行中', color: 'turquoise' }
    case 'error':
      return { label: '失败', color: 'red' }
    case 'success':
      return { label: '已完成', color: 'green' }
  }
}

export function escapeToolUseMarkdownText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([`*_{}[\]<>])/g, '\\$1')
}
