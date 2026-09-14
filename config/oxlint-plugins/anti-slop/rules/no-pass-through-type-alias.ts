import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

function isForwardedTypeParameter(
	typeArgument: ESTree.TSType,
	typeParameter: ESTree.TSTypeParameter,
): boolean {
	return (
		typeArgument.type === "TSTypeReference" &&
		typeArgument.typeName.type === "Identifier" &&
		typeArgument.typeName.name === typeParameter.name.name &&
		!typeArgument.typeArguments
	);
}

function passThroughTargetName(node: ESTree.TSTypeAliasDeclaration): string | null {
	const annotation = node.typeAnnotation;
	if (annotation.type !== "TSTypeReference" || annotation.typeName.type !== "Identifier") {
		return null;
	}

	const typeParameters = node.typeParameters?.params ?? [];
	const typeArguments = annotation.typeArguments?.params ?? [];
	const isPassThrough =
		typeParameters.length === typeArguments.length &&
		typeParameters.every((typeParameter, index) => isForwardedTypeParameter(typeArguments[index], typeParameter));
	return isPassThrough ? annotation.typeName.name : null;
}

/** Disallow type aliases that only rename another type. */
export const noPassThroughTypeAliasRule = defineRule({
	meta: {
		type: "suggestion",
		docs: { description: "Disallow type aliases that only rename another type" },
		messages: { passThroughAlias: "Use {{typeName}} directly instead of creating a pass-through type alias." },
		schema: [],
	},
	createOnce(context) {
		return {
			TSTypeAliasDeclaration(node) {
				const typeName = passThroughTargetName(node);
				if (typeName !== null) {
					context.report({
						data: { typeName },
						messageId: "passThroughAlias",
						node,
					});
				}
			},
		};
	},
});
