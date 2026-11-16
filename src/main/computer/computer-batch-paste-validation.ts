import { validateComputerClipboardPasteTextWithBoundedYield } from './action-contracts/computer-clipboard-paste-validation'
import type { ParsedStep } from './computer-batch'
import { RuntimeClientError } from './runtime-client-error'

// Why: the clipboard size limit otherwise runs only at dispatch, after earlier steps have already run.
export async function validateBatchPasteSteps(steps: ParsedStep[]): Promise<void> {
  for (const [index, step] of steps.entries()) {
    const text =
      step.kind === 'action' && step.method === 'pasteText' ? step.params.text : undefined
    if (typeof text !== 'string') {
      continue
    }
    try {
      await validateComputerClipboardPasteTextWithBoundedYield(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RuntimeClientError(
        'invalid_argument',
        `Batch step ${index + 1}: paste-text: ${message}`
      )
    }
  }
}
