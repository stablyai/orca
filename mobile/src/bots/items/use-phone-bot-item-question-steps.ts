// The desktop's question steps on the phone (src/shared/bots/use-bot-item-question-steps): an ask's
// held answers stay for the app session, as the comment box's drafts do.
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  botItemHeldAnswersScope,
  createBotItemQuestionStepsHooks
} from '../../../../src/shared/bots/use-bot-item-question-steps'

const held = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()

/** An ask's held answers on the item `itemScope` names, as stored. */
export function readPhoneBotItemHeldAnswers(itemScope: string, askId: string): string {
  return held.get(botItemHeldAnswersScope(itemScope, askId)) ?? ''
}

function useHeldDraft(scopeKey: string): { draft: string; setDraft: (next: string) => void } {
  const draft = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        const set = listeners.get(scopeKey) ?? new Set()
        set.add(listener)
        listeners.set(scopeKey, set)
        return () => {
          set.delete(listener)
          if (set.size === 0) {
            listeners.delete(scopeKey)
          }
        }
      },
      [scopeKey]
    ),
    () => held.get(scopeKey) ?? ''
  )
  const setDraft = useCallback(
    (next: string) => {
      if (next) {
        held.set(scopeKey, next)
      } else {
        held.delete(scopeKey)
      }
      listeners.get(scopeKey)?.forEach((listener) => listener())
    },
    [scopeKey]
  )
  return { draft, setDraft }
}

export const { useBotItemHeldAnswers, useBotItemQuestionSteps } = createBotItemQuestionStepsHooks(
  { useCallback, useLayoutEffect, useMemo, useRef, useState },
  useHeldDraft
)
