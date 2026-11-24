/** Git for Windows reports a file another program holds open this way (possibly still exiting 0). */
const UNLINK_FAILURE = /unable to unlink (?:old )?'(.*)': [^\n]*$/gm

/** Paths git could not replace, from checkout stderr; git quotes them raw, apostrophes included. */
export function parseCheckoutSkippedPaths(stderr: string): string[] {
  return [...new Set([...stderr.matchAll(UNLINK_FAILURE)].map((match) => match[1]))]
}
