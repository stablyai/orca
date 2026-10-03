#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
#include <sys/types.h>
typedef pid_t (*rfn)(pid_t);
int main(int argc, char **argv){
  rfn f = (rfn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  const char *src = "RTLD_DEFAULT";
  if(!f){
    void *h = dlopen("/usr/lib/system/libquarantine.dylib", RTLD_LAZY);
    if(h){ f=(rfn)dlsym(h,"responsibility_get_pid_responsible_for_pid"); src="libquarantine"; }
  }
  if(!f){ fprintf(stderr,"SYMBOL_NOT_FOUND: %s\n", dlerror()?dlerror():"(null)"); return 2; }
  fprintf(stderr,"symbol via %s\n", src);
  for(int i=1;i<argc;i++){
    pid_t p=(pid_t)atoi(argv[i]);
    pid_t r=f(p);
    printf("%d -> %d\n", p, r);
  }
  return 0;
}
