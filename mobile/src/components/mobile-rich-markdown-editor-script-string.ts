export function escapeInjectedJavaScriptString(value: string): string {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script')
}
