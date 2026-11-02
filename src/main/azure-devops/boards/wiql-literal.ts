/** WIQL string literal: single quotes, doubled to escape. Shared by every boards query. */
export function quoteWiqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
