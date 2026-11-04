import { useCallback, useMemo, useRef } from 'react'
import {
  createRepeatingDirectionHandle,
  scrollPaneViewport,
  type EdgeDirection,
  type EdgeNavigationTarget,
  type GamepadActionId
} from '../navigation/edge-arrows/edge-navigation-context'
import { createTerminalKeyChordInput } from '../terminal/terminal-key-chord-input'
import { hasStickyModifier } from '../terminal/terminal-sticky-modifiers'
import type { MobileSessionController } from './use-mobile-session-controller'
import { terminalDockKeyInput } from './use-terminal-dock-keys'

type TerminalArrowKey = 'arrowUp' | 'arrowDown' | 'arrowLeft' | 'arrowRight'

function arrowKeyForDirection(direction: EdgeDirection): TerminalArrowKey {
  switch (direction) {
    case 'up':
      return 'arrowUp'
    case 'down':
      return 'arrowDown'
    case 'left':
      return 'arrowLeft'
    case 'right':
      return 'arrowRight'
  }
}

export function useSessionEdgeNavigation({
  controller,
  obscured
}: {
  controller: MobileSessionController
  obscured: boolean
}): {
  terminalTarget: EdgeNavigationTarget
  contentTarget: EdgeNavigationTarget
  navigateSessionTabs: (direction: 'left' | 'right') => void
} {
  const controllerRef = useRef(controller)
  controllerRef.current = controller

  const { canSend, dockKeys, hostId, visibleTabs, worktreeId } = controller
  const modifierActive = hasStickyModifier(dockKeys.modifiers)
  const canNavigateRight = visibleTabs.length > 1

  const navigateSessionTabs = useCallback((direction: 'left' | 'right') => {
    const current = controllerRef.current
    const tabs = current.visibleTabs
    const activeTab = current.activeSessionTab
    const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1
    if (direction === 'left') {
      if (activeIndex > 0) {
        const previous = tabs[activeIndex - 1]
        if (previous) {
          current.switchSessionTab(previous)
          return
        }
      }
      current.requestLeaveSession()
      return
    }
    if (tabs.length > 1) {
      const nextIndex = activeIndex >= 0 ? (activeIndex + 1) % tabs.length : 0
      const next = tabs[nextIndex]
      if (next) {
        current.switchSessionTab(next)
      }
    }
  }, [])

  const terminalTarget = useMemo<EdgeNavigationTarget>(
    () => ({
      id: `session-terminal:${hostId}:${worktreeId}:${String(canSend)}`,
      kind: 'terminal',
      obscured,
      modifierActive,
      canNavigate: () => canSend,
      canPerformAction: () => canSend,
      preparePress: (direction: EdgeDirection) => {
        const current = controllerRef.current
        const arrowKey = arrowKeyForDirection(direction)
        const input = terminalDockKeyInput(arrowKey, current.dockKeys.takeModifiers())
        if (!input) {
          return { tap: () => {} }
        }
        const press = current.prepareAccessoryPress(input)
        return {
          tap: () => press.tap(),
          hold: (delayMs) => press.hold(delayMs),
          stop: () => current.stopAccessoryRepeat()
        }
      },
      performAction: (action: GamepadActionId) => {
        const current = controllerRef.current
        const modifiers = current.dockKeys.takeModifiers()
        const input =
          action === 'west'
            ? createTerminalKeyChordInput({
                key: 'm',
                ctrl: modifiers.ctrl !== 'off',
                alt: true,
                shift: modifiers.shift !== 'off'
              })
            : action === 'north'
              ? terminalDockKeyInput('tab', modifiers)
              : action === 'east'
                ? terminalDockKeyInput('escape', modifiers)
                : terminalDockKeyInput('enter', modifiers)
        if (!input) {
          return undefined
        }
        return current.prepareAccessoryPress(input).tap()
      }
    }),
    [canSend, hostId, modifierActive, obscured, worktreeId]
  )

  const contentTarget = useMemo<EdgeNavigationTarget>(
    () => ({
      id: `session-content:${hostId}:${worktreeId}:${String(canNavigateRight)}`,
      kind: 'content-window',
      obscured,
      canNavigate: (direction: EdgeDirection) => (direction === 'right' ? canNavigateRight : true),
      preparePress: (direction: EdgeDirection, paneNode?: unknown) => {
        if (direction === 'up' || direction === 'down') {
          return createRepeatingDirectionHandle(() => {
            scrollPaneViewport(paneNode, direction)
          }, true)
        }
        return createRepeatingDirectionHandle(() => {
          navigateSessionTabs(direction)
        }, false)
      }
    }),
    [canNavigateRight, hostId, navigateSessionTabs, obscured, worktreeId]
  )

  return { terminalTarget, contentTarget, navigateSessionTabs }
}
