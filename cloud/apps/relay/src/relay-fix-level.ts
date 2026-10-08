// Bump by one in any change that fixes a cell crash or a cell safety bug. Every runtime
// metrics line carries it, and an alert pages on a serving cell left below the newest
// level any cell reports, so a fleet that silently kept an unfixed image gets caught.
// Images from before this constant report nothing, which the alert reads as below.
export const RELAY_FIX_LEVEL = 1
