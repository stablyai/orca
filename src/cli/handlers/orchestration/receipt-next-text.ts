/** Older runtimes send no `next`, so their text is unchanged. */
export function withReceiptNext(text: string, receipt: { next?: string }): string {
  return receipt.next ? `${text}\nNext: ${receipt.next}` : text
}
