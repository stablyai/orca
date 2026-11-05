import type { TextGenerationFailureCode } from '../../../src/shared/text-generation-failure-copy'
import { translate } from '../i18n/mobile-i18n'

export const TEXT_GENERATION_SETTLEMENT_FAILURE_COPY = {
  generationCanceled: (values) =>
    translate(
      'sourceControl.textGenerationFailure.generationCanceled',
      'Generation canceled.',
      values
    ),
  generationAttemptBudgetEnded: (values) =>
    translate(
      'sourceControl.textGenerationFailure.generationAttemptBudgetEnded',
      'Generation attempt budget ended.',
      values
    ),
  generationRequestChanged: (values) =>
    translate(
      'sourceControl.textGenerationFailure.generationRequestChanged',
      'Generation request changed.',
      values
    ),
  generationAccountChanged: (values) =>
    translate(
      'sourceControl.textGenerationFailure.generationAccountChanged',
      'Generation account changed.',
      values
    ),
  subscriptionAccountsExhausted: (values) =>
    translate(
      'sourceControl.textGenerationFailure.subscriptionAccountsExhausted',
      'All {{attempted}} eligible accounts reached their subscription limit. Try again after a limit resets, or choose another account in Settings.',
      values
    ),
  subscriptionAttemptLimit: (values) =>
    translate(
      'sourceControl.textGenerationFailure.subscriptionAttemptLimit',
      '{{attempted}} accounts reached their subscription limit, the most Orca tries for one request. Try again later, or choose another account in Settings.',
      values
    ),
  subscriptionNoEligibleAlternate: (values) =>
    translate(
      'sourceControl.textGenerationFailure.subscriptionNoEligibleAlternate',
      'Subscription limits were reached and no other eligible account was available. Try again after a limit resets, or choose another account in Settings.',
      values
    ),
  subscriptionBudgetEnded: (values) =>
    translate(
      'sourceControl.textGenerationFailure.subscriptionBudgetEnded',
      'The account reached its subscription limit and the generation budget ended before another account could finish. Try again.',
      values
    )
} satisfies Partial<
  Record<TextGenerationFailureCode, (values: Record<string, string | number>) => string>
>
