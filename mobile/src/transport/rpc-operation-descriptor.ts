export type RpcOperationDescriptor<M extends string> = {
  readonly method: M
  readonly policy: string
}

export function defineRpcOperation<const M extends string>(
  descriptor: RpcOperationDescriptor<M>
): RpcOperationDescriptor<M> {
  return descriptor
}
