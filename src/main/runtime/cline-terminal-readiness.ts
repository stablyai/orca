// Cline 3.0.65's captured startup composer; this is not a general mid-turn idle signal.
export function isClineStartupPromptPreview(preview: string): boolean {
  const text = preview.trim()
  if (/clinepass|sign in|log in|permission|trust|thinking|working|[\u2801-\u28ff]/i.test(text)) {
    return false
  }
  return /Use \/ for slash commands, @ for file mentions, Ctrl\+P for menu\s*─+\s*❯\s*What can I do for you\?\s*─+\s*[^\n]{1,100}\(0\)\s*\$0\.00\s*○\s*Plan\s*●\s*Act\s*\(Tab\)\s*[^\n]{1,300}\s*⏵⏵\s*Auto-approve all enabled \(Shift\+Tab\)\s*$/u.test(
    text
  )
}
