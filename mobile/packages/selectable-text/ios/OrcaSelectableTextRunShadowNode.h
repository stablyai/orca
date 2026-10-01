#pragma once

#include <react/renderer/components/OrcaSelectableTextSpec/EventEmitters.h>
#include <react/renderer/components/OrcaSelectableTextSpec/Props.h>
#include <react/renderer/core/ConcreteShadowNode.h>

namespace facebook::react {
extern const char OrcaSelectableTextRunComponentName[];

// Text inside its root's string, never a mounted view: iOS TextShadowNode doesn't form a view either.
using OrcaSelectableTextRunShadowNode = ConcreteShadowNode<
    OrcaSelectableTextRunComponentName,
    ShadowNode,
    OrcaSelectableTextRunProps,
    OrcaSelectableTextRunEventEmitter>;
}
