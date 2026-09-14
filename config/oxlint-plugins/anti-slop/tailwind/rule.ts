import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { rewriteClassValue, summarizeChanges, uniqueTokens } from "./candidates.ts";
import { canonicalizeTokens, ensureDesignSystem, resolveCssPath } from "./design-system.ts";

export const PLUGIN_NAME = "deslop";
export const RULE_ID = "canonical-class-names";

const DEFAULT_ATTRIBUTES = ["class", "className"];
const DEFAULT_CALLEE_FUNCTIONS = ["cn", "clsx", "cva", "twMerge", "tw", "classNames", "cx"];
const DEFAULT_ROOT_FONT_SIZE = 16;

interface RuleOptions {
	cssPath: string;
	rootFontSize?: number;
	attributes?: Array<string>;
	calleeFunctions?: Array<string>;
}

const OPTIONS_SCHEMA = {
	type: "object",
	properties: {
		cssPath: { type: "string", description: "Path to the Tailwind v4 entry CSS." },
		rootFontSize: { type: "number", description: "Root font size in px used for rem normalization." },
		attributes: { type: "array", items: { type: "string" }, description: "JSX class-list attributes." },
		calleeFunctions: { type: "array", items: { type: "string" }, description: "Class-list helper functions." },
	},
	required: ["cssPath"],
	additionalProperties: false,
} as const;

type StringNode = ESTree.StringLiteral | ESTree.TemplateLiteral;

export const canonicalClassNames = defineRule({
	meta: {
		type: "suggestion",
		docs: { description: "Enforce canonical Tailwind CSS class spellings." },
		fixable: "code",
		messages: {
			nonCanonical: "Tailwind class '{{original}}' can be written as '{{canonical}}'.{{suffix}}",
			cssNotFound: "Could not load Tailwind CSS entry file: {{path}}",
		},
		schema: [OPTIONS_SCHEMA],
	},
	createOnce(context) {
		let attributes = new Set(DEFAULT_ATTRIBUTES);
		let callees = new Set(DEFAULT_CALLEE_FUNCTIONS);
		let rem = DEFAULT_ROOT_FONT_SIZE;
		let cssFile = "";
		let designKey: string | false | null = null;

		function initFile() {
			const options = (context.options?.[0] ?? {}) as Partial<RuleOptions>;
			attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);
			callees = new Set(options.calleeFunctions ?? DEFAULT_CALLEE_FUNCTIONS);
			rem = options.rootFontSize ?? DEFAULT_ROOT_FONT_SIZE;
			try {
				cssFile = resolveCssPath(options.cssPath);
			} catch {
				cssFile = options.cssPath ?? "";
			}
			designKey = null;
		}

		function getDesignKey(): string | null {
			if (designKey === null) {
				try { designKey = ensureDesignSystem(cssFile); } catch { designKey = false; }
			}
			return designKey === false ? null : designKey;
		}

		function checkStringNode(node: StringNode, value: string) {
			const tokens = uniqueTokens(value);
			if (tokens.length === 0) return;
			const key = getDesignKey();
			if (key === null) {
				context.report({ node, messageId: "cssNotFound", data: { path: cssFile } });
				return;
			}
			let canonicalOf: Map<string, string>;
			try { canonicalOf = canonicalizeTokens(key, tokens, rem); } catch { return; }
			const { fixed, changes } = rewriteClassValue(value, canonicalOf);
			if (changes.length === 0) return;
			const summary = summarizeChanges(changes);
			context.report({
				node,
				messageId: "nonCanonical",
				data: summary,
				fix(fixer) {
					const first = context.sourceCode.getText(node)[0];
					const quote = first === "'" || first === '"' || first === "`" ? first : '"';
					return fixer.replaceText(node, `${quote}${fixed}${quote}`);
				},
			});
		}

		function checkExpression(node: ESTree.Expression | ESTree.JSXEmptyExpression) {
			if (node.type === "Literal" && typeof node.value === "string") checkStringNode(node, node.value);
			else if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
				checkStringNode(node, node.quasis[0].value.raw);
			}
		}

		return {
			before() {
				initFile();
				const text = context.sourceCode.text;
				for (const name of attributes) if (name !== "" && text.includes(name)) return;
				for (const name of callees) if (name !== "" && text.includes(name)) return;
				return false;
			},
			JSXAttribute(node) {
				if (node.name.type !== "JSXIdentifier" || !attributes.has(node.name.name) || !node.value) return;
				if (node.value.type === "Literal" && typeof node.value.value === "string") checkStringNode(node.value, node.value.value);
				else if (node.value.type === "JSXExpressionContainer") checkExpression(node.value.expression);
			},
			CallExpression(node) {
				let name: string | null = null;
				if (node.callee.type === "Identifier") name = node.callee.name;
				else if (node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.type === "Identifier") name = node.callee.property.name;
				if (name === null || !callees.has(name)) return;
				for (const arg of node.arguments) if (arg.type === "Literal" || arg.type === "TemplateLiteral") checkExpression(arg);
			},
		};
	},
});
