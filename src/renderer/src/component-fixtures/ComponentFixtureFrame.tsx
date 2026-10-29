import { useEffect, type ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import { I18nProvider } from '../i18n/I18nProvider'
import type { ComponentFixture } from './component-fixture'

export type ComponentFixtureState = 'loading' | 'ready' | 'error'

const FRAME_ID = 'component-fixture-frame'
const CLIP_PADDING_PX = 8
const ANIMATION_SETTLE_TIMEOUT_MS = 1000

// The screenshot server waits on these attributes instead of guessing with timeouts.
export function markComponentFixtureState(state: ComponentFixtureState, message?: string): void {
  const root = document.documentElement
  root.dataset.fixtureState = state
  if (state === 'loading') {
    delete root.dataset.fixtureClip
  }
  if (message) {
    root.dataset.fixtureError = message
  } else {
    delete root.dataset.fixtureError
  }
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function waitForAnimationsToSettle(): Promise<void> {
  // Why finite only: looping spinners never finish and would stall every capture.
  const finite = document
    .getAnimations()
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
  const finished = Promise.allSettled(finite.map((animation) => animation.finished))
  await Promise.race([
    finished,
    new Promise((resolve) => setTimeout(resolve, ANIMATION_SETTLE_TIMEOUT_MS))
  ])
}

// Why union: popovers, menus and dialogs portal to <body>, outside the frame.
function recordCaptureClip(): void {
  const rects = [document.getElementById(FRAME_ID), ...document.body.children]
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .filter((element) => element.id !== 'root' && element.tagName !== 'SCRIPT')
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
  const frameRect = rects[0]
  if (!frameRect) {
    return
  }
  const left = Math.max(0, Math.min(...rects.map((rect) => rect.left)) - CLIP_PADDING_PX)
  const top = Math.max(0, Math.min(...rects.map((rect) => rect.top)) - CLIP_PADDING_PX)
  const right = Math.max(...rects.map((rect) => rect.right)) + CLIP_PADDING_PX
  const bottom = Math.max(...rects.map((rect) => rect.bottom)) + CLIP_PADDING_PX
  document.documentElement.dataset.fixtureClip = JSON.stringify({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  })
}

function FixtureReadySignal({ interact }: { interact: ComponentFixture['interact'] }): null {
  useEffect(() => {
    let cancelled = false
    const settle = async (): Promise<void> => {
      await document.fonts.ready
      await waitForPaint()
      const frame = document.getElementById(FRAME_ID)
      if (interact && frame) {
        await interact(frame)
        await waitForPaint()
      }
      await waitForAnimationsToSettle()
      if (cancelled || document.documentElement.dataset.fixtureState === 'error') {
        return
      }
      recordCaptureClip()
      markComponentFixtureState('ready')
    }
    settle().catch((error: unknown) => {
      markComponentFixtureState('error', error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [interact])
  return null
}

function FixtureRenderError({ error }: { error: Error | null }): React.JSX.Element {
  const message = error?.message ?? 'Fixture render failed.'
  useEffect(() => {
    markComponentFixtureState('error', message)
  }, [message])
  return <pre className="whitespace-pre-wrap text-xs text-destructive">{message}</pre>
}

function renderFixtureError({ error }: { error: Error | null }): React.JSX.Element {
  return <FixtureRenderError error={error} />
}

export function ComponentFixtureFrame({
  fixture,
  children
}: {
  fixture: ComponentFixture
  children: ReactNode
}): React.JSX.Element {
  return (
    <I18nProvider>
      <TooltipProvider delayDuration={400}>
        <div
          id={FRAME_ID}
          className="inline-block bg-background p-4 text-foreground"
          style={fixture.width ? { width: fixture.width } : undefined}
        >
          <RecoverableRenderErrorBoundary
            boundaryId="component-fixture"
            surface="app-root"
            reportAsCrash={false}
            fallback={renderFixtureError}
          >
            {children}
            <FixtureReadySignal interact={fixture.interact} />
          </RecoverableRenderErrorBoundary>
        </div>
      </TooltipProvider>
    </I18nProvider>
  )
}
