// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStateDot } from './AgentStateDot'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(cleanup)

describe('AgentStateDot accessible name', () => {
  it.each(['Turn ended', '本轮结束'])('exposes %s on a nameable done glyph', (label) => {
    render(
      <TooltipProvider>
        <AgentStateDot state="done" label={label} />
      </TooltipProvider>
    )

    expect(screen.getByRole('img', { name: label })).toHaveAccessibleName(label)
  })
})
