let noted = false

/** The user pointed Claude at their own API host; the proxy must not replace that. */
export function noteUserAnthropicBaseUrl(): void {
  if (noted) {
    return
  }
  noted = true
  console.info('[claude-auth-proxy] ANTHROPIC_BASE_URL is already set; leaving it unchanged')
}

export function resetUserAnthropicBaseUrlNote(): void {
  noted = false
}
