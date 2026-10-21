// Marks a folder workspace create refused before anything was stored. Its message is the code the
// create has always thrown, so every caller reads the same refusal it did before.
export class FolderWorkspaceCreateRefusedError extends Error {}
