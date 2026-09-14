export interface SpellingChange {
	original: string;
	canonical: string;
}

export function rewriteClassValue(
	value: string,
	canonicalOf: ReadonlyMap<string, string>,
): { fixed: string; changes: Array<SpellingChange> } {
	const changes: Array<SpellingChange> = [];
	const fixed = value.replace(/\S+/g, (token) => {
		const canonical = canonicalOf.get(token);
		if (canonical !== undefined && canonical !== token) {
			changes.push({ original: token, canonical });
			return canonical;
		}
		return token;
	});
	return { fixed, changes };
}

export function uniqueTokens(value: string): Array<string> {
	const tokens = value.match(/\S+/g) ?? [];
	return [...new Set(tokens)];
}

export function summarizeChanges(changes: ReadonlyArray<SpellingChange>): {
	original: string;
	canonical: string;
	suffix: string;
} {
	const first = changes[0];
	return {
		original: first.original,
		canonical: first.canonical,
		suffix: changes.length > 1 ? ` (+${changes.length - 1} more in this string)` : "",
	};
}
