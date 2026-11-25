/** Copyright (c) 2026 ByteDance Ltd. and/or its affiliates. SPDX-License-Identifier: MIT
 * Adapted from larksuite/openclaw-lark@dde0be3680d6fd5443cab426c8f4b3216266346a; see UPSTREAM.md. */
import { buildToolUseStepElements, type CardElement, type ToolUseDisplayStep } from './tool-steps'
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}
export function buildStreamingToolUseActivePanel(params: {
  steps: ToolUseDisplayStep[]
  elapsedMs?: number
  totalSteps?: number
}): CardElement {
  const { steps, elapsedMs, totalSteps = steps.length } = params
  const enParts = ['Tool use']
  const zhParts = ['工具执行']

  if (steps.length > 0) {
    enParts.push(`${totalSteps} step${totalSteps === 1 ? '' : 's'}`)
    zhParts.push(`${totalSteps} 步`)
  }

  if (elapsedMs != null && elapsedMs > 0) {
    const d = formatElapsed(elapsedMs)
    enParts.push(`(${d})`)
    zhParts.push(`(${d})`)
  }

  return {
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: {
        tag: 'plain_text',
        content: `🛠️ ${zhParts.join(' · ')}`,
        i18n_content: {
          zh_cn: `🛠️ ${zhParts.join(' · ')}`,
          en_us: `🛠️ ${enParts.join(' · ')}`
        },
        text_color: 'grey',
        text_size: 'notation'
      },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px'
      },
      icon_position: 'right',
      icon_expanded_angle: -180
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '8px 8px 8px 8px',
    elements: steps.flatMap((step) => buildToolUseStepElements(step))
  }
}
