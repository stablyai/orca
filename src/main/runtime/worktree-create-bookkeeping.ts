/** Bookkeeping a launch asked for: logged when it fails, never allowed to fail the create. */
export async function notifyCreateBookkeeping(
  label: string,
  notify: () => Promise<void> | undefined
): Promise<void> {
  try {
    await notify()
  } catch (error) {
    console.warn(`[worktree-create] ${label} bookkeeping failed:`, error)
  }
}
