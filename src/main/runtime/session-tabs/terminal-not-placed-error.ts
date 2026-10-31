/**
 * The layout owner answered that it did not show the terminal, or the request never reached it.
 * Only this failure proves no tab will show the terminal; a timeout or a lost answer does not.
 */
export class TerminalNotPlacedError extends Error {}

/** The window didn't answer the reveal in time: the terminal may be on screen, or may not. */
export class TerminalRevealUnconfirmedError extends Error {}
